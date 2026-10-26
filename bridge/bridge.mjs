#!/usr/bin/env node
// paperclip-harness-gateway: runs local coding-agent CLIs (Claude Code, pi, Codex, …)
// as Paperclip agents. Each harness is served at /<harness> using the Hermes
// API-server run contract, so in Paperclip it is an ordinary "hermes_gateway" agent
// with apiBaseUrl http://<host>:8787/<harness>:
//
//   GET  /health, /v1/health              {"status":"ok"} (no auth)
//   GET  /<h>/health[/detailed]           auth check (Paperclip's Test Environment)
//   GET  /<h>/v1/models, /v1/capabilities discovery
//   POST /<h>/v1/runs                     {input, instructions?, session_id?, conversation_history?} -> 202 {run_id, status:"started"}
//   GET  /<h>/v1/runs/:id                 {object:"hermes.run", status, output, usage, runtime, ...}
//   GET  /<h>/v1/runs/:id/events          SSE: message.delta, reasoning.available, then run.<terminal>
//   POST /<h>/v1/runs/:id/stop            {"status":"stopping"}; the run settles "cancelled"
//   GET  /admin, /admin/api               ops view (any harness key)
//   POST /wake                            legacy "http" adapter, fire-and-forget on the claude harness
//
// Every /<h>/... route is also served under /<h>/api/... . Per-harness files live
// in ~/.paperclip/agents/<h>/: gateway-key (the bearer Paperclip sends) and
// credentials.json (the claimed Paperclip API key the agent uses to call back).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { timingSafeEqual, randomUUID, createHash } from "node:crypto";
import { readFileSync, mkdirSync, openSync, closeSync, writeSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "./lib/store.mjs";
import { ADMIN_HTML, createActivity } from "./lib/admin.mjs";
import claude from "./runners/claude.mjs";
import pi from "./runners/pi.mjs";
import codex from "./runners/codex.mjs";

const RUNNERS = { claude, pi, codex };
if (process.env.BRIDGE_TEST === "1") RUNNERS.fake = (await import("./runners/fake.mjs")).default;

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.PAPERCLIP_HOME || join(homedir(), ".paperclip");
const CONFIG = {
  bind: process.env.BRIDGE_BIND || "127.0.0.1",
  port: Number(process.env.BRIDGE_PORT || 8787),
  workspace: resolve(process.env.BRIDGE_WORKSPACE || join(HERE, "..", "workspace")),
  extraDirs: (process.env.BRIDGE_EXTRA_DIRS || join(homedir(), "projects")).split(":").filter(Boolean),
  maxConcurrency: Number(process.env.BRIDGE_MAX_CONCURRENCY || 1), // running, per harness
  maxQueued: Number(process.env.BRIDGE_MAX_QUEUED || 20), // waiting, per harness; beyond this: 429
  runTimeoutMs: Number(process.env.BRIDGE_RUN_TIMEOUT_MS || 60 * 60 * 1000),
  drainMs: Number(process.env.BRIDGE_DRAIN_MS || 20_000),
  retainMs: 60 * 60 * 1000, // full in-memory event buffers; status snapshots persist 24h
};
const skillPath = join(CONFIG.workspace, ".claude", "skills", "paperclip", "SKILL.md");
const runsDir = join(HOME, "runs");
mkdirSync(runsDir, { recursive: true, mode: 0o700 });

const store = openStore(join(HOME, "bridge-state.json"));
const activity = createActivity();
const startedAt = Date.now();

function log(text) {
  console.log(new Date().toISOString(), text);
  activity.push(text);
}

// ---------------------------------------------------------------------------
// Per-harness agent files, re-read on use so a claimed key needs no restart.

const agentDir = (harness) => join(HOME, "agents", harness);

function readGatewayKey(harness) {
  try {
    return readFileSync(join(agentDir(harness), "gateway-key"), "utf8").trim();
  } catch {
    return null;
  }
}

function loadCreds(harness) {
  try {
    return JSON.parse(readFileSync(join(agentDir(harness), "credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

function authorized(req, harness) {
  const key = readGatewayKey(harness);
  if (!key) return false;
  const want = Buffer.from(`Bearer ${key}`);
  const got = Buffer.from(req.headers.authorization || "");
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---------------------------------------------------------------------------
// Runs. Statuses follow Hermes: queued → running → (stopping →) completed | failed | cancelled | interrupted.

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const runs = new Map(); // run_id -> live run (event buffers kept retainMs after settling)
let draining = false;

function createRun({ harness, prompt, sessionKey, paperclipRunId, bodyHash, taskId, legacy = false, extraEnv = {}, requestedModel }) {
  const run = {
    id: `run_${randomUUID().replace(/-/g, "")}`,
    harness,
    prompt,
    sessionKey,
    paperclipRunId,
    taskId,
    legacy,
    extraEnv,
    requestedModel,
    status: "queued",
    createdAt: Date.now(),
    events: [],
    delivered: 0, // events already sent over SSE; Paperclip reconnects without Last-Event-ID
    subscribers: new Set(),
    pendingDelta: "",
    deltaTimer: null,
    output: "",
    lastText: "",
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    costUsd: 0,
    model: null,
    provider: RUNNERS[harness].provider,
    harnessSessionId: null,
    error: null,
    child: null,
  };
  runs.set(run.id, run);
  store.admit(harness, paperclipRunId, run.id, bodyHash, snapshot(run));
  log(`run ${run.id} [${harness}] queued (paperclip run ${paperclipRunId ?? "-"}, task ${taskId ?? "-"})`);
  pump();
  return run;
}

function usagePayload(u) {
  // Hermes names cache reads cache_read_tokens; Paperclip's adapter reads cached_input_tokens.
  // input_tokens counts cache writes, which bill at (more than) the input rate.
  const input = u.input_tokens + u.cache_write_tokens;
  return {
    input_tokens: input,
    output_tokens: u.output_tokens,
    total_tokens: input + u.cache_read_tokens + u.output_tokens,
    cache_read_tokens: u.cache_read_tokens,
    cache_write_tokens: u.cache_write_tokens,
    cached_input_tokens: u.cache_read_tokens,
  };
}

function snapshot(run) {
  return {
    object: "hermes.run",
    run_id: run.id,
    harness: run.harness,
    status: run.status,
    session_id: run.sessionKey || undefined,
    harness_session_id: run.harnessSessionId || undefined,
    model: run.requestedModel || run.model || undefined,
    output: run.output || run.lastText || undefined,
    error: run.error || undefined,
    usage: usagePayload(run.usage),
    cost_usd: run.costUsd || undefined,
    runtime: { provider: run.provider, model: run.model || undefined, route_source: "global" },
    task_id: run.taskId || undefined,
    paperclip_run_id: run.paperclipRunId || undefined,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    ...(draining && !TERMINAL.has(run.status) ? { shutdown_requested_at: Math.floor(drainStartedAt / 1000) } : {}),
  };
}

function emit(run, event, data) {
  if (event !== "message.delta") flushDelta(run);
  run.events.push({ event, data: { event, run_id: run.id, ...data } });
  for (const res of run.subscribers) flush(run, res);
}

// pi streams one token per event; Paperclip logs every SSE event as its own transcript
// line, so deltas are coalesced into ~250 ms chunks.
function queueDelta(run, text) {
  run.pendingDelta += text;
  if (run.pendingDelta.length > 2000) return flushDelta(run);
  run.deltaTimer ||= setTimeout(() => flushDelta(run), 250);
}

function flushDelta(run) {
  clearTimeout(run.deltaTimer);
  run.deltaTimer = null;
  if (!run.pendingDelta) return;
  const delta = run.pendingDelta;
  run.pendingDelta = "";
  emit(run, "message.delta", { delta });
}

function finish(run, status, error = null) {
  if (TERMINAL.has(run.status)) return;
  run.status = status;
  run.error = error;
  run.finishedAt = Date.now();
  const snap = snapshot(run);
  store.settle(run.id, snap);
  emit(run, `run.${status}`, snap);
  for (const res of run.subscribers) res.end();
  run.subscribers.clear();
  setTimeout(() => runs.delete(run.id), CONFIG.retainMs).unref();
}

const queuedCount = (harness) => [...runs.values()].filter((r) => r.harness === harness && r.status === "queued").length;

// One run at a time per Paperclip session key (= per issue), maxConcurrency per harness.
function pump() {
  if (draining) return;
  for (const harness of Object.keys(RUNNERS)) {
    const active = [...runs.values()].filter((r) => r.harness === harness && (r.status === "running" || r.status === "stopping"));
    let slots = CONFIG.maxConcurrency - active.length;
    const busyKeys = new Set(active.map((r) => r.sessionKey).filter(Boolean));
    const queued = [...runs.values()].filter((r) => r.harness === harness && r.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
    for (const run of queued) {
      if (slots <= 0) break;
      if (run.sessionKey && busyKeys.has(run.sessionKey)) continue;
      slots--;
      if (run.sessionKey) busyKeys.add(run.sessionKey);
      execute(run)
        .catch((err) => {
          log(`run ${run.id} crashed: ${err?.stack || err}`);
          finish(run, "failed", `gateway error: ${err?.message || err}`);
        })
        .finally(pump);
    }
  }
}

function buildEnv(run, creds) {
  const env = { ...process.env };
  delete env.CLAUDECODE; // don't let a parent Claude session leak into runs
  Object.assign(env, {
    PAPERCLIP_API_URL: creds.apiUrl,
    PAPERCLIP_API_KEY: creds.apiKey,
    PAPERCLIP_AGENT_ID: creds.agentId || "",
    PAPERCLIP_COMPANY_ID: creds.companyId || "",
  });
  if (run.paperclipRunId) env.PAPERCLIP_RUN_ID = run.paperclipRunId;
  if (run.taskId) env.PAPERCLIP_TASK_ID = run.taskId;
  for (const [k, v] of Object.entries(run.extraEnv)) if (v) env[k] = String(v);
  return env;
}

function runtimeNotes(runner) {
  return [
    "## Runtime notes (gateway)",
    "",
    ...(runner.needsSkillPointer
      ? [`- Paperclip skill: read ${skillPath} first and follow its heartbeat procedure; its scripts/ and references/ sit next to it.`]
      : ["- Use the `paperclip` skill and follow its heartbeat procedure."]),
    "- PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID and PAPERCLIP_RUN_ID are set in your environment. Never print the API key.",
    `- Your scratch workspace is ${CONFIG.workspace}. The operator's repos live under ${CONFIG.extraDirs.join(", ")}; clone new repos into ${join(CONFIG.workspace, "repos")}.`,
    "- No human is watching this session. Do not ask questions here; use Paperclip interactions for human input.",
  ].join("\n");
}

async function execute(run) {
  const runner = RUNNERS[run.harness];
  const creds = loadCreds(run.harness);
  if (!creds?.apiKey) {
    log(`run ${run.id} [${run.harness}] failed: no credentials (claim pending)`);
    return finish(run, "failed", `gateway has no Paperclip credentials for ${run.harness}; run bin/claim-api-key.sh ${run.harness}`);
  }
  run.status = "running";
  run.startedAt = Date.now();

  const logPath = join(runsDir, `${run.paperclipRunId || run.id}.log`);
  const prompt = `${run.prompt}\n\n${runtimeNotes(runner)}`;
  const env = buildEnv(run, creds);
  const prior = run.sessionKey ? store.session(run.harness, run.sessionKey) : undefined;
  log(`run ${run.id} [${run.harness}] started${prior ? ` (resuming ${prior})` : ""}`);

  let outcome = await spawnRunner(run, runner, { prompt, env, resumeId: prior, logPath });
  // A stale session id fails before any output; retry once from a fresh session.
  if (prior && !outcome.gotResult && outcome.code !== 0 && run.status === "running" && run.events.length === 0) {
    log(`run ${run.id}: resume of ${prior} failed; retrying with a fresh session`);
    store.dropSession(run.harness, run.sessionKey);
    outcome = await spawnRunner(run, runner, { prompt, env, logPath });
  }

  if (run.sessionKey && run.harnessSessionId) store.setSession(run.harness, run.sessionKey, run.harnessSessionId);
  if (run.status === "stopping") return finish(run, "cancelled", "Stopped by Paperclip.");
  if (TERMINAL.has(run.status)) return; // interrupted by shutdown

  const stderr = outcome.stderrTail.trim();
  const why = outcome.timedOut
    ? `timed out after ${Math.round(CONFIG.runTimeoutMs / 60000)} min`
    : outcome.code !== 0
      ? `${run.harness} exited with code ${outcome.code}`
      : outcome.isError
        ? `${run.harness} reported an error`
        : null;
  if (why) {
    const detail = [run.output && outcome.isError ? run.output : null, stderr ? `stderr: ${stderr.slice(-1500)}` : null].filter(Boolean).join("\n");
    finish(run, "failed", detail ? `${why}\n${detail}` : why);
  } else {
    finish(run, "completed");
  }
  log(`run ${run.id} [${run.harness}] ${run.status}${why ? ` (${why})` : ""}: $${(run.costUsd || 0).toFixed(4)} in=${run.usage.input_tokens} out=${run.usage.output_tokens}`);
  if (why && run.legacy && run.taskId) await reportLegacyFailure(creds, run, why);
}

const unknownEventsLogged = new Set();

function spawnRunner(run, runner, { prompt, env, resumeId, logPath }) {
  return new Promise((resolvePromise) => {
    const args = runner.args({
      prompt,
      resumeId,
      sessionKey: run.sessionKey,
      workspace: CONFIG.workspace,
      extraDirs: CONFIG.extraDirs,
      model: run.requestedModel || process.env[`BRIDGE_${run.harness.toUpperCase()}_MODEL`] || "",
    });
    const logFd = openSync(logPath, "a", 0o600);
    // detached: own process group, so stop/timeout also kills the tools it spawned.
    const child = spawn(runner.bin, args, { cwd: CONFIG.workspace, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    run.child = child;

    // Keep the claimed key and gateway key out of anything handed back to Paperclip.
    const secrets = [env.PAPERCLIP_API_KEY, readGatewayKey(run.harness)].filter((s) => s && s.length >= 8);
    const redact = (s) => secrets.reduce((acc, sec) => acc.split(sec).join("[redacted]"), String(s ?? ""));

    const outcome = { code: null, timedOut: false, isError: false, gotResult: false, stderrTail: "" };
    const out = {
      delta: (text) => text && queueDelta(run, redact(text)),
      tool: (name, summary) => queueDelta(run, `\n▸ ${name}${summary ? `: ${redact(summary)}` : ""}\n`),
      reasoning: (text) => text && emit(run, "reasoning.available", { text: redact(text) }),
      session: (id) => id && (run.harnessSessionId = id),
      model: (m) => m && (run.model = m),
      provider: (p) => p && (run.provider = p),
      lastText: (t) => (run.lastText = redact(t)),
      addUsage: (u) => {
        for (const k of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]) run.usage[k] += u[k] || 0;
        run.costUsd += u.cost_usd || 0;
      },
      result: (r) => {
        outcome.gotResult = true;
        if (r.isError) outcome.isError = true;
        if (r.output) run.output = redact(r.output);
        if (r.costUsd != null) run.costUsd = r.costUsd;
        if (r.usage) run.usage = { ...run.usage, ...r.usage };
      },
    };

    createInterface({ input: child.stdout }).on("line", (line) => {
      writeSync(logFd, `${line}\n`);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const type = event?.type;
      if (typeof type === "string" && !runner.knownEvents.has(type) && !unknownEventsLogged.has(`${runner.name}:${type}`)) {
        unknownEventsLogged.add(`${runner.name}:${type}`);
        log(`warning: unhandled ${runner.name} event type ${JSON.stringify(type).slice(0, 80)} (CLI output format may have changed)`);
      }
      try {
        runner.parse(event, out);
      } catch (err) {
        writeSync(logFd, `[gateway] parse error: ${err.message}\n`);
      }
    });
    child.stderr.on("data", (chunk) => {
      writeSync(logFd, chunk);
      outcome.stderrTail = redact((outcome.stderrTail + chunk).slice(-2048));
    });

    const timer = setTimeout(() => {
      outcome.timedOut = true;
      killRun(run);
    }, CONFIG.runTimeoutMs);

    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.child = null;
      flushDelta(run);
      outcome.code = code;
      try {
        writeSync(logFd, `\n--- [gateway] exit ${code}${outcome.timedOut ? " (timeout)" : ""} ---\n`);
        closeSync(logFd);
      } catch {}
      resolvePromise(outcome);
    };
    child.on("close", done);
    child.on("error", (err) => {
      outcome.stderrTail = `failed to start ${runner.bin}: ${err.message}`;
      done(-1);
    });
  });
}

function killRun(run, graceMs = 10_000) {
  const child = run.child;
  if (!child) return;
  const signalGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  signalGroup("SIGTERM");
  setTimeout(() => child.exitCode === null && signalGroup("SIGKILL"), graceMs).unref();
}

// ---------------------------------------------------------------------------
// Legacy "http" adapter wake (fire-and-forget; Paperclip already marked its run done).

function legacyPrompt(wake, creds) {
  const ctx = wake.context || {};
  const lines = [
    `You are the Paperclip agent "${creds.agentName || "Claude Code"}", woken by a Paperclip heartbeat.`,
    "",
    "## Paperclip Wake Payload",
    "",
    `- runId: ${wake.runId}`,
    `- agentId: ${wake.agentId}`,
    `- taskId: ${ctx.taskId ?? "none (no specific task: check your inbox)"}`,
    `- wakeReason: ${ctx.wakeReason ?? "unknown"}`,
    `- commentId: ${ctx.commentId ?? "none"}`,
    "",
    "Full wake context (JSON):",
    "```json",
    JSON.stringify(ctx, null, 2),
    "```",
    "",
    "Before exiting, leave the issue in a valid final disposition as the skill describes.",
  ];
  if (wake.connectionInstructions?.text) lines.push("", "## Connection instructions", "", wake.connectionInstructions.text);
  return lines.join("\n");
}

function handleLegacyWake(wake) {
  const creds = loadCreds("claude") || {};
  const ctx = wake.context || {};
  const prior = store.idempotency("claude", wake.runId);
  if (prior) return { duplicate: true, run_id: prior.run_id };
  // Same key shape as the Hermes adapter's "issue" strategy, so sessions carry over
  // when the agent is switched from http to hermes_gateway.
  const sessionKey = ctx.taskId ? `paperclip:company:${creds.companyId}:agent:${wake.agentId}:issue:${ctx.taskId}` : null;
  const run = createRun({
    harness: "claude",
    prompt: legacyPrompt(wake, creds),
    sessionKey,
    paperclipRunId: wake.runId,
    bodyHash: null,
    taskId: ctx.taskId,
    legacy: true,
    extraEnv: {
      PAPERCLIP_WAKE_REASON: ctx.wakeReason,
      PAPERCLIP_WAKE_COMMENT_ID: ctx.commentId,
      PAPERCLIP_APPROVAL_ID: ctx.approvalId,
      PAPERCLIP_APPROVAL_STATUS: ctx.approvalStatus,
    },
  });
  return { run_id: run.id };
}

async function reportLegacyFailure(creds, run, why) {
  const body = [
    "Gateway: run failed",
    "",
    `- The ${run.harness} run for wake \`${run.paperclipRunId}\` failed: ${why}.`,
    "- Any partial progress is in the comments above; the operator can inspect the run log on the agent host.",
    "- Next step: retry by re-waking this agent or commenting on this issue.",
  ].join("\n");
  try {
    const res = await fetch(`${creds.apiUrl}/api/issues/${run.taskId}/comments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.apiKey}`, "X-Paperclip-Run-Id": run.paperclipRunId, "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    log(`failure comment on ${run.taskId}: HTTP ${res.status}`);
  } catch (err) {
    log(`failure comment on ${run.taskId} failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    Object.assign(this, { status, code, headers });
  }
}

function send(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(obj === undefined ? undefined : JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) {
        reject(new HttpError(413, "payload_too_large", "request body exceeds 5 MB"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, "invalid_params", "request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function flush(run, res) {
  while (run.delivered < run.events.length) {
    const { event, data } = run.events[run.delivered++];
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function streamEvents(run, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");
  flush(run, res);
  if (TERMINAL.has(run.status)) return res.end();
  run.subscribers.add(res);
  const ping = setInterval(() => res.write(": keepalive\n\n"), 10_000);
  res.on("close", () => {
    clearInterval(ping);
    run.subscribers.delete(res);
  });
}

function validateRunBody(body) {
  const bad = (msg) => new HttpError(400, "invalid_params", msg);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad("body must be a JSON object");
  if (typeof body.input !== "string" || !body.input.trim()) throw bad("body.input must be a non-empty string");
  for (const k of ["session_id", "instructions", "previous_response_id", "model"]) {
    if (body[k] !== undefined && body[k] !== null && typeof body[k] !== "string") throw bad(`body.${k} must be a string`);
  }
  if (body.conversation_history !== undefined && !Array.isArray(body.conversation_history)) throw bad("body.conversation_history must be an array");
}

function runPrompt(body) {
  const parts = [];
  if (body.instructions) parts.push(body.instructions);
  if (body.conversation_history?.length) {
    parts.push(
      "## Conversation so far",
      body.conversation_history.map((m) => `${m.role || "user"}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n"),
    );
  }
  parts.push(body.input);
  return parts.join("\n\n");
}

const taskIdFromSessionKey = (key) => key?.match(/:issue:([^:]+)$/)?.[1];

async function createRunFromRequest(req, res, harness) {
  if (draining) throw new HttpError(503, "runtime_draining", "gateway is shutting down", { "Retry-After": "5" });
  const body = await readJson(req);
  validateRunBody(body);
  const idemKey = req.headers["idempotency-key"];
  if (idemKey !== undefined && !/^[\x21-\x7e]{1,255}$/.test(idemKey)) throw new HttpError(400, "invalid_params", "Idempotency-Key must be 1-255 visible ASCII characters");
  const sessionKey = body.session_id || req.headers["x-hermes-session-key"] || null;
  if (sessionKey && (sessionKey.length > 256 || /[\r\n\0]/.test(sessionKey))) throw new HttpError(400, "invalid_params", "session key must be at most 256 characters without control characters");

  const bodyHash = createHash("sha256")
    .update(JSON.stringify([body.input, body.instructions ?? null, body.session_id ?? null, body.conversation_history ?? null, body.previous_response_id ?? null, body.model ?? null]))
    .digest("hex");
  const echo = sessionKey ? { "X-Hermes-Session-Key": sessionKey } : {};
  if (idemKey) {
    const prior = store.idempotency(harness, idemKey);
    if (prior) {
      if (prior.bodyHash && prior.bodyHash !== bodyHash) throw new HttpError(409, "idempotency_key_conflict", "Idempotency-Key already used with a different body");
      const status = runs.get(prior.run_id)?.status || store.run(prior.run_id)?.status || "started";
      return send(res, 202, { run_id: prior.run_id, status }, { "Idempotency-Replayed": "true", ...echo });
    }
  }
  if (queuedCount(harness) >= CONFIG.maxQueued) throw new HttpError(429, "rate_limited", `Too many queued runs (max ${CONFIG.maxQueued})`, { "Retry-After": "30" });

  const run = createRun({
    harness,
    prompt: runPrompt(body),
    sessionKey,
    paperclipRunId: idemKey || null,
    bodyHash,
    taskId: taskIdFromSessionKey(sessionKey),
    requestedModel: body.model || undefined,
  });
  return send(res, 202, { run_id: run.id, status: "started" }, echo);
}

async function handleHarness(req, res, harness, rest) {
  if (!authorized(req, harness)) throw new HttpError(401, "unauthorized", "missing or invalid bearer token");
  rest = rest.replace(/^\/api(?=\/)/, "").replace(/^\/v1(?=\/health)/, "");
  const runner = RUNNERS[harness];

  if (req.method === "GET" && rest === "/health") return send(res, 200, { status: "ok" });
  if (req.method === "GET" && rest === "/health/detailed") {
    const live = [...runs.values()].filter((r) => r.harness === harness && !TERMINAL.has(r.status));
    return send(res, 200, {
      status: loadCreds(harness)?.apiKey ? "ok" : "degraded",
      readiness: { checks: { credentials: Boolean(loadCreds(harness)?.apiKey), workspace: existsSync(CONFIG.workspace), skill: existsSync(skillPath) } },
      runs: { running: live.filter((r) => r.status !== "queued").length, queued: live.filter((r) => r.status === "queued").length },
      draining,
    });
  }
  if (req.method === "GET" && rest === "/v1/models") return send(res, 200, { object: "list", data: [{ id: `${harness}-agent`, object: "model", owned_by: runner.provider }] });
  if (req.method === "GET" && rest === "/v1/capabilities") {
    return send(res, 200, { object: "hermes.capabilities", session_key_header: "X-Hermes-Session-Key", features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true } });
  }
  if (rest === "/v1/runs") {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST to create a run");
    return createRunFromRequest(req, res, harness);
  }

  const m = rest.match(/^\/v1\/runs\/([^/]+)(\/events|\/stop)?$/);
  if (!m) throw new HttpError(404, "not_found", "no such route");
  const id = decodeURIComponent(m[1]);
  const run = runs.get(id);
  const stored = !run && store.run(id);
  if ((!run && !stored) || (run || stored).harness !== harness) throw new HttpError(404, "not_found", "run not found");

  if (req.method === "GET" && !m[2]) return send(res, 200, run ? snapshot(run) : stored);
  if (req.method === "GET" && m[2] === "/events") {
    if (run) return streamEvents(run, res);
    // Settled before this process started: replay just the terminal event.
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    return res.end(`event: run.${stored.status}\ndata: ${JSON.stringify({ event: `run.${stored.status}`, ...stored })}\n\n`);
  }
  if (req.method === "POST" && m[2] === "/stop") {
    if (!run || TERMINAL.has(run.status)) return send(res, 200, { status: (run || stored).status });
    if (run.status === "queued") {
      finish(run, "cancelled", "Stopped by Paperclip before it started.");
      return send(res, 200, { status: "cancelled" });
    }
    run.status = "stopping";
    killRun(run);
    log(`run ${run.id} [${harness}] stop requested`);
    return send(res, 200, { status: "stopping" });
  }
  throw new HttpError(405, "method_not_allowed", "method not allowed");
}

function adminAuthorized(req) {
  return Object.keys(RUNNERS).some((h) => authorized(req, h));
}

function adminApi() {
  const live = [...runs.values()];
  const liveIds = new Set(live.map((r) => r.id));
  const rows = [...live.map(snapshot), ...store.recentRuns(100).filter((r) => !liveIds.has(r.run_id))]
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
    .slice(0, 50)
    .map((r) => ({
      run_id: r.run_id,
      harness: r.harness,
      status: r.status,
      task_id: r.task_id,
      started_at: r.started_at,
      duration_ms: r.started_at ? (r.finished_at || Date.now()) - r.started_at : null,
      cost_usd: r.cost_usd,
      error: r.error,
      output_tail: r.output ? r.output.slice(-200) : undefined,
    }));
  return {
    uptime_ms: Date.now() - startedAt,
    harnesses: Object.keys(RUNNERS),
    running: live.filter((r) => r.status === "running" || r.status === "stopping").length,
    queued: live.filter((r) => r.status === "queued").length,
    draining,
    runs: rows,
    activity: activity.recent(100),
  };
}

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const path = new URL(req.url, "http://x").pathname.replace(/\/+$/, "") || "/";

    // Unauthenticated liveness: HEAD anywhere (http adapter's Test Environment), GET /health.
    if (req.method === "HEAD") return send(res, 200);
    if (req.method === "GET" && (path === "/health" || path === "/v1/health")) return send(res, 200, { status: "ok" });

    if (req.method === "GET" && path === "/admin") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(ADMIN_HTML);
    }
    if (req.method === "GET" && path === "/admin/api") {
      if (!adminAuthorized(req)) throw new HttpError(401, "unauthorized", "missing or invalid bearer token");
      return send(res, 200, adminApi());
    }

    if (req.method === "POST" && path === "/wake") {
      if (!authorized(req, "claude")) throw new HttpError(401, "unauthorized", "missing or invalid bearer token");
      if (draining) throw new HttpError(503, "runtime_draining", "gateway is shutting down", { "Retry-After": "5" });
      const wake = await readJson(req);
      if (!wake.runId) wake.runId = `bridge-${randomUUID()}`;
      return send(res, 202, { accepted: true, runId: wake.runId, ...handleLegacyWake(wake) });
    }

    const m = path.match(/^\/([a-z0-9_-]+)(\/.*)$/);
    if (m && RUNNERS[m[1]]) return await handleHarness(req, res, m[1], m[2]);
    throw new HttpError(404, "not_found", "no such route");
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) return send(res, err.status, { error: { code: err.code, message: err.message } }, err.headers);
    log(`request error: ${err?.stack || err}`);
    send(res, 500, { error: { code: "internal_error", message: "internal gateway error" } });
  }
});

server.listen(CONFIG.port, CONFIG.bind, () => {
  log(`gateway listening on http://${CONFIG.bind}:${CONFIG.port} (workspace ${CONFIG.workspace})`);
  for (const h of Object.keys(RUNNERS)) {
    const key = existsSync(join(agentDir(h), "gateway-key"));
    const creds = Boolean(loadCreds(h)?.apiKey);
    if (key || creds) log(`  ${h}: gateway-key ${key ? "ok" : "MISSING"}, credentials ${creds ? "ok" : "missing (claim pending)"}`);
  }
  if (!existsSync(skillPath)) log(`warning: paperclip skill missing at ${skillPath}; run bin/install-skill.sh`);
});

// Drain like Hermes: refuse new runs (503), give active ones drainMs to finish, then
// record them as "interrupted" before killing them, so pollers see a terminal status.
let drainStartedAt = 0;
function shutdown(sig) {
  if (draining) return;
  draining = true;
  drainStartedAt = Date.now();
  const active = () => [...runs.values()].filter((r) => r.child);
  log(`${sig}: draining ${active().length} active runs (up to ${CONFIG.drainMs / 1000}s)`);
  for (const run of runs.values()) if (run.status === "queued") finish(run, "interrupted", "Gateway shutdown before the run started.");
  const deadline = Date.now() + CONFIG.drainMs;
  const check = setInterval(() => {
    if (active().length && Date.now() < deadline) return;
    clearInterval(check);
    for (const run of active()) {
      finish(run, "interrupted", "Gateway shutdown interrupted the run.");
      killRun(run, 3000);
    }
    server.close();
    setTimeout(() => process.exit(0), active().length ? 4000 : 0);
  }, 250);
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => shutdown(sig));
