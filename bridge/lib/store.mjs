// Durable gateway state in one JSON file (0600):
//   sessions     harness -> Paperclip session key -> harness session id
//   idempotency  "<harness>:<Idempotency-Key>" -> {run_id, bodyHash, ts}   (24h, like Hermes)
//   runs         run_id -> last status snapshot (terminal runs kept 24h, max 500)
//   active       run_id -> harness, for runs not yet settled
// On load, runs still listed as active belonged to a previous process and are
// settled as "interrupted", so pollers get a terminal answer instead of a 404.

import { readFileSync, writeFileSync, renameSync } from "node:fs";

const DAY = 24 * 60 * 60 * 1000;
const MAX_RUNS = 500;

export function openStore(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    data = {};
  }
  data = { sessions: {}, idempotency: {}, runs: {}, active: {}, ...data };

  const now = Date.now();
  for (const id of Object.keys(data.active)) {
    data.runs[id] = {
      ...(data.runs[id] || { run_id: id, harness: data.active[id] }),
      status: "interrupted",
      error: "Gateway restarted while the run was active.",
      updatedAt: now,
    };
  }
  data.active = {};

  function prune() {
    const t = Date.now();
    for (const [k, v] of Object.entries(data.idempotency)) if (t - v.ts > DAY) delete data.idempotency[k];
    const settled = Object.entries(data.runs).filter(([id]) => !data.active[id]);
    for (const [id, r] of settled) if (t - (r.updatedAt || 0) > DAY) delete data.runs[id];
    const rest = Object.entries(data.runs).filter(([id]) => !data.active[id]).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [id] of rest.slice(0, Math.max(0, rest.length - MAX_RUNS))) delete data.runs[id];
  }

  function save() {
    prune();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }

  save();

  return {
    session: (harness, key) => data.sessions[harness]?.[key],
    setSession(harness, key, id) {
      (data.sessions[harness] ||= {})[key] = id;
      save();
    },
    dropSession(harness, key) {
      if (data.sessions[harness]) delete data.sessions[harness][key];
      save();
    },
    idempotency: (harness, key) => data.idempotency[`${harness}:${key}`],
    // Called once per run start; the run is marked active in the same write.
    admit(harness, key, runId, bodyHash, snapshot) {
      if (key) data.idempotency[`${harness}:${key}`] = { run_id: runId, bodyHash, ts: Date.now() };
      data.active[runId] = harness;
      data.runs[runId] = { ...snapshot, updatedAt: Date.now() };
      save();
    },
    settle(runId, snapshot) {
      delete data.active[runId];
      data.runs[runId] = { ...snapshot, updatedAt: Date.now() };
      for (const v of Object.values(data.idempotency)) if (v.run_id === runId) v.ts = Date.now();
      save();
    },
    run: (runId) => data.runs[runId],
    recentRuns: (n) => Object.values(data.runs).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, n),
  };
}
