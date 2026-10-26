#!/usr/bin/env node
// Paperclip bridge: runs local coding-agent harnesses (Claude Code, pi, Codex, …)
// as Paperclip agents. Speaks the Hermes gateway run protocol, so the Paperclip
// agent uses adapterType "hermes_gateway" with apiBaseUrl http://<host>:8787/<harness>:
//
//   GET  /<h>/health                  auth check for Paperclip's Test Environment
//   POST /<h>/v1/runs                 {input, instructions, session_id} -> {run_id}
//   GET  /<h>/v1/runs/:id             {status, output, usage, cost_usd, ...}
//   GET  /<h>/v1/runs/:id/events      SSE: message.delta ... run.completed|failed|cancelled
//   POST /<h>/v1/runs/:id/stop
//
// Legacy: POST /wake (Paperclip "http" adapter) runs the claude harness fire-and-forget.
//
// Each harness is its own Paperclip agent with its own files in ~/.paperclip/agents/<h>/:
// gateway-key (bearer Paperclip sends us) and credentials.json (claimed Paperclip key).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, writeSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import claude from "./runners/claude.mjs";
import pi from "./runners/pi.mjs";
import codex from "./runners/codex.mjs";

const RUNNERS = { claude, pi, codex };

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.PAPERCLIP_HOME || join(homedir(), ".paperclip");
const CONFIG = {
  bind: process.env.BRIDGE_BIND || "127.0.0.1",
  port: Number(process.env.BRIDGE_PORT || 8787),
  workspace: resolve(process.env.BRIDGE_WORKSPACE || join(HERE, "..", "workspace")),
  extraDirs: (process.env.BRIDGE_EXTRA_DIRS || join(homedir(), "projects")).split(":").filter(Boolean),
  maxConcurrency: Number(process.env.BRIDGE_MAX_CONCURRENCY || 1), // per harness
  runTimeoutMs: Number(process.env.BRIDGE_RUN_TIMEOUT_MS || 60 * 60 * 1000),
  retainMs: 60 * 60 * 1000,
};
const skillPath = join(CONFIG.workspace, ".claude", "skills", "paperclip", "SKILL.md");
const stateFile = join(HOME, "bridge-state.json");
const runsDir = join(HOME, "runs");
mkdirSync(runsDir, { recursive: true, mode: 0o700 });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Per-harness agent files. Re-read on use so claiming a key needs no restart.

function agentDir(harness) {
  return join(HOME, "agents", harness);
}

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
// Persistent state: harness session ids per Paperclip session key, plus ids of
// unsettled runs so a restart can answer "failed" instead of 404 (Paperclip would
// otherwise keep polling a vanished run until its own timeout).

function loadState() {
  try {
    return { sessions: {}, active: {}, orphaned: {}, ...JSON.parse(readFileSync(stateFile, "utf8")) };
  } catch {
    return { sessions: {}, active: {}, orphaned: {} };
  }
}

const state = loadState();
for (const [id, harness] of Object.entries(state.active)) {
  state.orphaned[id] = { harness, at: Date.now() };
}
state.active = {};
for (const [id, o] of Object.entries(state.orphaned)) {
  if (Date.now() - o.at > 24 * 60 * 60 * 1000) delete state.orphaned[id];
}
saveState();

function saveState() {
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, stateFile);
}

function orphanSummary(id) {
  return { run_id: id, status: "failed", error: "bridge restarted while this run was active" };
}

// ---------------------------------------------------------------------------
// Runs

const runs = new Map(); // run_id -> run
const byIdempotencyKey = new Map(); // `${harness}:${key}` -> run_id
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function createRun({ harness, prompt, sessionKey, paperclipRunId, taskId, legacy = false, extraEnv = {} }) {
  const run = {
    id: randomUUID(),
    harness,
    prompt,
    sessionKey,
    paperclipRunId,
    taskId,
    legacy,
    extraEnv,
    status: "queued",
    createdAt: Date.now(),
    events: [],
    delivered: 0, // events already sent over SSE; Paperclip reconnects without Last-Event-ID
    subscribers: new Set(),
    output: "",
    lastText: "",
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    costUsd: 0,
    model: null,
    harnessSessionId: null,
    error: null,
    child: null,
  };
  runs.set(run.id, run);
  if (paperclipRunId) byIdempotencyKey.set(`${harness}:${paperclipRunId}`, run.id);
  state.active[run.id] = harness;
  saveState();
  pump();
  return run;
}

function emit(run, event, data) {
  run.events.push({ event, data: { event, ...data } });
  for (const res of run.subscribers) flush(run, res);
}

function finish(run, status, error = null) {
  if (TERMINAL.has(run.status)) return;
  run.status = status;
  run.error = error;
  run.finishedAt = Date.now();
  delete state.active[run.id];
  saveState();
  emit(run, `run.${status}`, runSummary(run));
  for (const res of run.subscribers) res.end();
  run.subscribers.clear();
  setTimeout(() => {
    runs.delete(run.id);
    if (run.paperclipRunId) byIdempotencyKey.delete(`${run.harness}:${run.paperclipRunId}`);
  }, CONFIG.retainMs).unref();
}

function runSummary(run) {
  return {
    run_id: run.id,
    status: run.status,
    output: run.output || run.lastText || undefined,
    error: run.error || undefined,
    usage: run.usage,
    cost_usd: run.costUsd || undefined,
    model: run.model || undefined,
    session_id: run.harnessSessionId || undefined,
  };
}

// One run at a time per Paperclip session key (= per issue), maxConcurrency per harness.
function pump() {
  for (const harness of Object.keys(RUNNERS)) {
    const active = [...runs.values()].filter((r) => r.harness === harness && r.status === "running");
    let slots = CONFIG.maxConcurrency - active.length;
    const busyKeys = new Set(active.map((r) => r.sessionKey).filter(Boolean));
    const queued = [...runs.values()]
      .filter((r) => r.harness === harness && r.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const run of queued) {
      if (slots <= 0) break;
      if (run.sessionKey && busyKeys.has(run.sessionKey)) continue;
      slots--;
      if (run.sessionKey) busyKeys.add(run.sessionKey);
      execute(run)
        .catch((err) => {
          log(`run ${run.id} crashed:`, err);
          finish(run, "failed", String(err?.message || err));
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
  for (const [k, v] of Object.entries(run.extraEnv || {})) if (v) env[k] = String(v);
  return env;
}

function runtimeNotes(runner) {
  return [
    "## Runtime notes (bridge)",
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
    return finish(run, "failed", `bridge has no Paperclip credentials for ${run.harness}; run bin/claim-api-key.sh ${run.harness}`);
  }
  run.status = "running";
  run.startedAt = Date.now();

  const logPath = join(runsDir, `${run.paperclipRunId || run.id}.log`);
  const prompt = `${run.prompt}\n\n${runtimeNotes(runner)}`;
  const env = buildEnv(run, creds);
  const sessions = (state.sessions[run.harness] ||= {});
  const prior = run.sessionKey ? sessions[run.sessionKey] : undefined;
  log(`run ${run.id} [${run.harness}] starting (paperclip run ${run.paperclipRunId ?? "-"}, task ${run.taskId ?? "-"}${prior ? `, resuming ${prior}` : ""})`);

  let outcome = await spawnRunner(run, runner, { prompt, env, resumeId: prior, logPath });
  if (prior && !outcome.gotResult && outcome.code !== 0 && run.status === "running" && run.events.length === 0) {
    log(`run ${run.id}: resume of ${prior} failed; retrying with a fresh session`);
    delete sessions[run.sessionKey];
    outcome = await spawnRunner(run, runner, { prompt, env, logPath });
  }

  if (run.sessionKey && run.harnessSessionId) {
    sessions[run.sessionKey] = run.harnessSessionId;
    saveState();
  }
  if (run.status === "cancelled") return;

  const failed = outcome.timedOut || outcome.code !== 0 || outcome.isError;
  const why = outcome.timedOut
    ? `timed out after ${Math.round(CONFIG.runTimeoutMs / 60000)} min`
    : outcome.code !== 0
      ? `${run.harness} exited with code ${outcome.code}`
      : outcome.isError
        ? `${run.harness} reported an error`
        : null;
  finish(run, failed ? "failed" : "completed", failed ? why : null);
  log(
    `run ${run.id} [${run.harness}] ${run.status}${why ? ` (${why})` : ""}: cost=$${run.costUsd || "?"}` +
      ` in=${run.usage.input_tokens} out=${run.usage.output_tokens} log=${logPath}`,
  );
  if (failed && run.legacy && run.taskId) await reportLegacyFailure(creds, run, why);
}

function spawnRunner(run, runner, { prompt, env, resumeId, logPath }) {
  return new Promise((resolvePromise) => {
    const args = runner.args({
      prompt,
      resumeId,
      sessionKey: run.sessionKey,
      workspace: CONFIG.workspace,
      extraDirs: CONFIG.extraDirs,
      model: process.env[`BRIDGE_${run.harness.toUpperCase()}_MODEL`] || "",
    });
    const logFd = openSync(logPath, "a", 0o600);
    // detached: own process group, so stop/timeout also kills the tools it spawned.
    const child = spawn(runner.bin, args, { cwd: CONFIG.workspace, env, stdio: ["ignore", "pipe", logFd], detached: true });
    run.child = child;

    // Keep the claimed key and gateway key out of anything we hand back to Paperclip.
    const secrets = [env.PAPERCLIP_API_KEY, readGatewayKey(run.harness)].filter((s) => s && s.length >= 8);
    const redact = (s) => secrets.reduce((acc, sec) => acc.split(sec).join("[redacted]"), String(s ?? ""));

    const outcome = { code: null, timedOut: false, isError: false, gotResult: false };
    const out = {
      delta: (text) => text && emit(run, "message.delta", { delta: redact(text) }),
      session: (id) => id && (run.harnessSessionId = id),
      model: (m) => m && (run.model = m),
      lastText: (t) => (run.lastText = redact(t)),
      addUsage: (u) => {
        run.usage.input_tokens += u.input_tokens || 0;
        run.usage.cached_input_tokens += u.cached_input_tokens || 0;
        run.usage.output_tokens += u.output_tokens || 0;
        run.costUsd += u.cost_usd || 0;
      },
      result: (r) => {
        outcome.gotResult = true;
        if (r.isError) outcome.isError = true;
        if (r.output) run.output = redact(r.output);
        if (r.costUsd != null) run.costUsd = r.costUsd;
        if (r.usage) run.usage = r.usage;
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
      try {
        runner.parse(event, out);
      } catch (err) {
        writeSync(logFd, `[bridge] parse error: ${err.message}\n`);
      }
    });

    const timer = setTimeout(() => {
      outcome.timedOut = true;
      killRun(run);
    }, CONFIG.runTimeoutMs);

    const done = (code) => {
      clearTimeout(timer);
      run.child = null;
      outcome.code = code;
      try {
        writeSync(logFd, `\n--- [bridge] exit ${code}${outcome.timedOut ? " (timeout)" : ""} ---\n`);
        closeSync(logFd);
      } catch {}
      resolvePromise(outcome);
    };
    child.on("close", done);
    child.on("error", (err) => {
      try {
        writeSync(logFd, `[bridge] spawn error: ${err.message}\n`);
      } catch {}
      done(-1);
    });
  });
}

function killRun(run) {
  const child = run.child;
  if (!child) return;
  const signalGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  signalGroup("SIGTERM");
  setTimeout(() => child.exitCode === null && signalGroup("SIGKILL"), 10_000).unref();
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
  const key = `claude:${wake.runId}`;
  if (byIdempotencyKey.has(key)) return { duplicate: true, run_id: byIdempotencyKey.get(key) };
  // Same key shape as the Hermes adapter's "issue" strategy, so sessions carry over
  // when the agent is switched from http to hermes_gateway.
  const sessionKey = ctx.taskId ? `paperclip:company:${creds.companyId}:agent:${wake.agentId}:issue:${ctx.taskId}` : null;
  const run = createRun({
    harness: "claude",
    prompt: legacyPrompt(wake, creds),
    sessionKey,
    paperclipRunId: wake.runId,
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
    "Bridge: run failed",
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
    log(`failure comment on ${run.taskId} failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(obj === undefined ? undefined : JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error("invalid json"), { status: 400 }));
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
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  res.on("close", () => {
    clearInterval(ping);
    run.subscribers.delete(res);
  });
}

function taskIdFromSessionKey(key) {
  return key?.match(/:issue:([^:]+)$/)?.[1];
}

async function handleHarness(req, res, harness, rest) {
  if (!authorized(req, harness)) return send(res, 401, { error: "unauthorized" });
  rest = rest.replace(/^\/api(?=\/)/, ""); // Paperclip may map a dashboard-style base to /api

  if (req.method === "GET" && rest === "/health") {
    return send(res, 200, { ok: true, harness, credentials: Boolean(loadCreds(harness)?.apiKey) });
  }
  if (req.method === "POST" && rest === "/v1/runs") {
    if (shuttingDown) {
      res.setHeader("Retry-After", "5");
      return send(res, 503, { error: "bridge is shutting down" });
    }
    const body = await readJson(req);
    const paperclipRunId = req.headers["idempotency-key"] || null;
    const existing = paperclipRunId && byIdempotencyKey.get(`${harness}:${paperclipRunId}`);
    if (existing) return send(res, 200, { run_id: existing, status: runs.get(existing)?.status });
    const sessionKey = body.session_id || req.headers["x-hermes-session-key"] || null;
    const prompt = [body.instructions, body.input].filter(Boolean).join("\n\n");
    if (!prompt) return send(res, 400, { error: "input is required" });
    const run = createRun({ harness, prompt, sessionKey, paperclipRunId, taskId: taskIdFromSessionKey(sessionKey) });
    return send(res, 202, { run_id: run.id, status: run.status });
  }

  const m = rest.match(/^\/v1\/runs\/([^/]+)(\/events|\/stop)?$/);
  const run = m && runs.get(decodeURIComponent(m[1]));
  if (!m) return send(res, 404, { error: "not found" });
  if (!run && state.orphaned[m[1]]?.harness === harness) {
    const summary = orphanSummary(m[1]);
    if (m[2] !== "/events") return send(res, 200, summary);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    return res.end(`event: run.failed\ndata: ${JSON.stringify({ event: "run.failed", ...summary })}\n\n`);
  }
  if (!run || run.harness !== harness) return send(res, 404, { error: "run not found" });

  if (req.method === "GET" && !m[2]) return send(res, 200, runSummary(run));
  if (req.method === "GET" && m[2] === "/events") return streamEvents(run, res);
  if (req.method === "POST" && m[2] === "/stop") {
    if (!TERMINAL.has(run.status)) {
      finish(run, "cancelled", "stopped by Paperclip");
      killRun(run);
      log(`run ${run.id} [${harness}] stopped by Paperclip`);
    }
    return send(res, 200, runSummary(run));
  }
  return send(res, 405, { error: "method not allowed" });
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://x").pathname.replace(/\/+$/, "") || "/";

    // Unauthenticated liveness: HEAD anywhere (http adapter's Test Environment) and GET /health.
    if (req.method === "HEAD") return send(res, 200);
    if (req.method === "GET" && path === "/health") {
      const active = [...runs.values()].filter((r) => !TERMINAL.has(r.status));
      return send(res, 200, { ok: true, harnesses: Object.keys(RUNNERS), running: active.filter((r) => r.status === "running").length, queued: active.filter((r) => r.status === "queued").length });
    }

    if (req.method === "POST" && path === "/wake") {
      if (!authorized(req, "claude")) return send(res, 401, { error: "unauthorized" });
      const wake = await readJson(req);
      if (!wake.runId) wake.runId = `bridge-${randomUUID()}`;
      return send(res, 202, { accepted: true, runId: wake.runId, ...handleLegacyWake(wake) });
    }

    const m = path.match(/^\/([a-z0-9_-]+)(\/.*)$/);
    if (m && RUNNERS[m[1]]) return await handleHarness(req, res, m[1], m[2]);
    return send(res, 404, { error: "not found" });
  } catch (err) {
    if (!res.headersSent) send(res, err.status || 500, { error: err.message });
  }
});

server.listen(CONFIG.port, CONFIG.bind, () => {
  log(`paperclip bridge listening on http://${CONFIG.bind}:${CONFIG.port} (workspace ${CONFIG.workspace})`);
  for (const h of Object.keys(RUNNERS)) {
    const key = existsSync(join(agentDir(h), "gateway-key"));
    const creds = Boolean(loadCreds(h)?.apiKey);
    if (key || creds) log(`  ${h}: gateway-key ${key ? "ok" : "MISSING"}, credentials ${creds ? "ok" : "missing (claim pending)"}`);
  }
});

let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    shuttingDown = true;
    log(`${sig}: stopping; killing ${[...runs.values()].filter((r) => r.child).length} active runs`);
    for (const run of runs.values()) killRun(run);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
