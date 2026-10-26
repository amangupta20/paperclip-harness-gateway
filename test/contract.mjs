#!/usr/bin/env node
// Hermes-contract tests against a real gateway process using the fake harness.
// Usage: node test/contract.mjs        (no network, no model calls)

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "test-gateway-key-0123456789";
const API_KEY = "sk-test-paperclip-secret-xyz";
const AUTH = { Authorization: `Bearer ${KEY}` };
const SK = "paperclip:company:c1:agent:a1:issue:ISS-1";

const home = mkdtempSync(join(tmpdir(), "gw-test-"));
mkdirSync(join(home, "agents", "fake"), { recursive: true });
writeFileSync(join(home, "agents", "fake", "gateway-key"), KEY);
writeFileSync(join(home, "agents", "fake", "credentials.json"), JSON.stringify({ apiUrl: "http://127.0.0.1:9", apiKey: API_KEY, agentId: "a1", companyId: "c1" }));
const workspace = join(home, "ws");
mkdirSync(workspace);

let gw;
async function startGateway() {
  gw = spawn(process.execPath, [join(ROOT, "bridge", "bridge.mjs")], {
    env: { ...process.env, BRIDGE_TEST: "1", PAPERCLIP_HOME: home, BRIDGE_PORT: String(PORT), BRIDGE_WORKSPACE: workspace, BRIDGE_DRAIN_MS: "1500", BRIDGE_MAX_QUEUED: "3" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  gw.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`  [gw] ${d}`));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("gateway did not start");
}
const stopGateway = () => new Promise((r) => (gw.once("exit", r), gw.kill("SIGTERM")));

const j = async (method, path, body, headers = {}) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...AUTH, "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};
const create = (input, extra = {}, headers = {}) => j("POST", "/fake/v1/runs", { input, session_id: SK, ...extra }, headers);

async function events(runId) {
  const res = await fetch(`${BASE}/fake/v1/runs/${runId}/events`, { headers: AUTH });
  const text = await res.text();
  return text.split("\n\n").filter((f) => f.includes("data:")).map((f) => ({
    event: f.match(/^event: (.*)$/m)?.[1],
    data: JSON.parse(f.match(/^data: (.*)$/m)[1]),
  }));
}
async function waitFor(runId, pred, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const { body } = await j("GET", `/fake/v1/runs/${runId}`);
    if (pred(body)) return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting on ${runId}`);
}
const pgrep = (pattern) => new Promise((r) => spawn("pgrep", ["-f", pattern]).on("exit", (c) => r(c === 0)));
async function pidAlive(pattern, want = true, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await pgrep(pattern)) === want) return want;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !want;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("health is public, harness routes need the key", async () => {
  assert.deepEqual((await (await fetch(`${BASE}/health`)).json()), { status: "ok" });
  assert.equal((await fetch(`${BASE}/fake/health`)).status, 401);
  assert.equal((await j("GET", "/fake/health")).status, 200);
  assert.equal((await j("GET", "/fake/api/health")).status, 200);
  assert.equal((await j("GET", "/fake/v1/runs")).status, 405);
  const bad = await j("POST", "/fake/v1/runs", { input: "" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_params");
});

test("create, stream and poll a run", async () => {
  const c = await create("THINK TOOL hello", {}, { "Idempotency-Key": "pc-1" });
  assert.equal(c.status, 202);
  assert.equal(c.body.status, "started");
  assert.equal(c.headers.get("x-hermes-session-key"), SK);
  const evs = await events(c.body.run_id);
  const names = evs.map((e) => e.event);
  assert.ok(names.includes("reasoning.available"), names.join());
  assert.equal(names.at(-1), "run.completed");
  assert.ok(evs.filter((e) => e.event !== "run.completed").every((e) => !("status" in e.data)), "only the terminal event may carry status");
  const text = evs.filter((e) => e.event === "message.delta").map((e) => e.data.delta).join("");
  assert.match(text, /▸ Bash: ls -la/);
  assert.match(text, /OK resume=none task=ISS-1/);
  const s = await j("GET", `/fake/v1/runs/${c.body.run_id}`);
  assert.equal(s.body.object, "hermes.run");
  assert.equal(s.body.status, "completed");
  assert.equal(s.body.session_id, SK);
  assert.equal(s.body.usage.cached_input_tokens, 50);
  assert.equal(s.body.usage.cache_read_tokens, 50);
  assert.equal(s.body.runtime.model, "fake-1");
});

test("admin: data needs a key, run detail has the transcript", async () => {
  assert.equal((await fetch(`${BASE}/admin/api`)).status, 401);
  const d = await j("GET", "/admin/api");
  assert.equal(d.body.key_required, true);
  const run = d.body.runs.find((r) => r.status === "completed");
  assert.equal(run.session_id, SK);
  const r = await j("GET", `/admin/api/runs/${run.run_id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.transcript_complete, true);
  assert.ok(r.body.transcript.some((t) => t.kind === "reasoning"));
  assert.match(r.body.transcript.filter((t) => t.kind === "text").map((t) => t.text).join(""), /▸ Bash: ls -la/);
  assert.equal((await j("GET", "/admin/api/runs/run_nope")).status, 404);
});

test("idempotent replay and conflict", async () => {
  const r = await create("THINK TOOL hello", {}, { "Idempotency-Key": "pc-1" });
  assert.equal(r.status, 202);
  assert.equal(r.headers.get("idempotency-replayed"), "true");
  assert.equal(r.body.status, "completed");
  const conflict = await create("something else", {}, { "Idempotency-Key": "pc-1" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "idempotency_key_conflict");
});

test("same issue resumes the harness session", async () => {
  const c = await create("again");
  const s = await waitFor(c.body.run_id, (b) => b.status === "completed");
  assert.match(s.output, /resume=fake-\d+/);
});

test("token deltas are coalesced", async () => {
  const c = await create("TOKENS", { session_id: "other-session" });
  const deltas = (await events(c.body.run_id)).filter((e) => e.event === "message.delta");
  assert.ok(deltas.length <= 3, `expected coalesced deltas, got ${deltas.length}`);
});

test("secrets are redacted", async () => {
  const c = await create("ECHOKEY", { session_id: "redact" });
  const s = await waitFor(c.body.run_id, (b) => b.status === "completed");
  assert.ok(!JSON.stringify(s).includes(API_KEY));
  assert.match(s.output, /\[redacted\]/);
});

test("failure carries the stderr tail", async () => {
  const c = await create("FAIL", { session_id: "fail" });
  const evs = await events(c.body.run_id);
  const last = evs.at(-1);
  assert.equal(last.event, "run.failed");
  assert.match(last.data.error, /exited with code 3/);
  assert.match(last.data.error, /simulated failure/);
});

test("runs on one issue are serialized, stop kills the process group", async () => {
  const a = await create("SLEEP 30 first", { session_id: "serial" });
  const b = await create("second", { session_id: "serial" });
  try {
    await waitFor(a.body.run_id, (x) => x.status === "running");
    assert.equal((await j("GET", `/fake/v1/runs/${b.body.run_id}`)).body.status, "queued");
    assert.ok(await pidAlive("^sleep 30$"), "fake harness should have spawned sleep");
    const stop = await j("POST", `/fake/v1/runs/${a.body.run_id}/stop`);
    assert.equal(stop.body.status, "stopping");
    await waitFor(a.body.run_id, (x) => x.status === "cancelled");
    assert.equal(await pidAlive("^sleep 30$", false), false, "child sleep should be killed with the group");
    await waitFor(b.body.run_id, (x) => x.status === "completed");
  } finally {
    await j("POST", `/fake/v1/runs/${a.body.run_id}/stop`);
  }
});

test("queue limit answers 429", async () => {
  const blockers = [];
  for (let i = 0; i < 4; i++) blockers.push(await create(`SLEEP 5 q${i}`, { session_id: `q${i}` }));
  const over = await create("over", { session_id: "q-over" });
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, "rate_limited");
  for (const r of blockers) await j("POST", `/fake/v1/runs/${r.body.run_id}/stop`);
});

test("restart: drained runs are interrupted, replay survives", async () => {
  const c = await create("SLEEP 30 long", { session_id: "drain" }, { "Idempotency-Key": "pc-drain" });
  await waitFor(c.body.run_id, (x) => x.status === "running");
  await stopGateway();
  await startGateway();
  const s = await j("GET", `/fake/v1/runs/${c.body.run_id}`);
  assert.equal(s.body.status, "interrupted");
  const evs = await events(c.body.run_id);
  assert.equal(evs.at(-1).event, "run.interrupted");
  const replay = await create("SLEEP 30 long", { session_id: "drain" }, { "Idempotency-Key": "pc-drain" });
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal(replay.body.run_id, c.body.run_id);
  const oldReplay = await create("THINK TOOL hello", {}, { "Idempotency-Key": "pc-1" });
  assert.equal(oldReplay.headers.get("idempotency-replayed"), "true");
  const old = await j("GET", `/fake/v1/runs/${oldReplay.body.run_id}`);
  assert.equal(old.body.status, "completed", "settled runs from before the restart keep their status");
  assert.equal(old.body.usage.cached_input_tokens, 50);
});

let failed = 0;
try {
  await startGateway();
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${t.name}\n     ${err.message.split("\n").join("\n     ")}`);
    }
  }
} finally {
  if (gw && gw.exitCode === null) await stopGateway();
  rmSync(home, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
