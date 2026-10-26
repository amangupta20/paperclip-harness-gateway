// Dashboard history: one JSON file per settled run in <dir>/<run_id>.json holding the
// run snapshot and its structured transcript ("parts"), kept BRIDGE_HISTORY_DAYS
// (default 30). Everything in here was already redacted when it was recorded.
//
// Part kinds: prompt (what Paperclip sent), text (assistant output), tool (one tool
// call), reasoning (model thinking), error (terminal failure detail).

import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DAY = 24 * 60 * 60 * 1000;
const MAX_RUNS = 5000;

export function openHistory(dir, { days = 30 } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const index = new Map(); // run_id -> snapshot (no parts)

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const { run } = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (run?.run_id) index.set(run.run_id, run);
    } catch {}
  }

  function prune() {
    const cutoff = Date.now() - days * DAY;
    const all = [...index.values()].sort((a, b) => (a.finished_at || 0) - (b.finished_at || 0));
    const drop = all.filter((r, i) => (r.finished_at || 0) < cutoff || i < all.length - MAX_RUNS);
    for (const r of drop) {
      index.delete(r.run_id);
      try {
        unlinkSync(join(dir, `${r.run_id}.json`));
      } catch {}
    }
  }
  prune();

  return {
    save(run, parts) {
      const file = join(dir, `${run.run_id}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify({ run, parts }), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      index.set(run.run_id, run);
      prune();
    },
    run: (id) => index.get(id),
    parts(id) {
      try {
        return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")).parts || [];
      } catch {
        return [];
      }
    },
    all: () => [...index.values()],
  };
}
