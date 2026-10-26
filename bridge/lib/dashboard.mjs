// Operator dashboard: the React app in ui/dist served at /admin, plus its JSON API
// under /admin/api. Read endpoints need any harness's gateway key unless
// BRIDGE_ADMIN_PUBLIC=1; stopping a run always needs that run's harness key.
//
//   GET  /admin/api/state                      gateway, agents, conversations, activity
//   GET  /admin/api/threads/:harness/:key      one conversation (all its runs, with parts)
//   GET  /admin/api/runs/:id?from=N            one run's parts from index N (live tailing)
//   POST /admin/api/runs/:id/stop              stop a queued or running run

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";

const DAY = 24 * 60 * 60 * 1000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json" };

export function createDashboard(ctx) {
  const { CONFIG, RUNNERS, TERMINAL, runs, snapshot, store, history, activity, loadCreds, agentDir, authorized, killRun, finish, log, HttpError, send, startedAt, isDraining } = ctx;
  const uiDir = join(ctx.root, "ui", "dist");
  const issues = new Map(); // issue id -> { identifier, title, status, fetchedAt } | { pending }

  // ---- data ---------------------------------------------------------------

  const threadKey = (r) => r.session_id || `run:${r.run_id}`;
  const issueIdOf = (r) => r.task_id || r.session_id?.match(/:issue:([^:]+)$/)?.[1];

  // Every run we know about, newest snapshot wins: live > history > state file.
  function allRuns() {
    const byId = new Map();
    for (const r of store.recentRuns(500)) byId.set(r.run_id, r);
    for (const r of history.all()) byId.set(r.run_id, r);
    for (const run of runs.values()) byId.set(run.id, snapshot(run));
    return [...byId.values()].filter((r) => r.harness && RUNNERS[r.harness]);
  }

  function issueInfo(harness, id) {
    if (!id) return null;
    const hit = issues.get(id);
    const fresh = hit && Date.now() - hit.fetchedAt < (hit.error ? 60_000 : 5 * 60_000);
    if (!fresh && !hit?.pending) lookupIssue(harness, id, hit);
    return hit && !hit.pending ? hit : hit?.prev || null;
  }

  async function lookupIssue(harness, id, prev) {
    const creds = loadCreds(harness);
    if (!creds?.apiKey) return;
    issues.set(id, { pending: true, prev, fetchedAt: Date.now() });
    try {
      const res = await fetch(`${creds.apiUrl}/api/issues/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${creds.apiKey}` }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const i = await res.json();
      const prefix = i.identifier?.split("-")[0];
      issues.set(id, {
        id,
        identifier: i.identifier || null,
        title: i.title || null,
        status: i.status || null,
        priority: i.priority || null,
        url: prefix && i.identifier ? `${creds.apiUrl}/${prefix}/issues/${i.identifier}` : null,
        fetchedAt: Date.now(),
      });
    } catch (err) {
      issues.set(id, { ...(prev || { id }), error: err.message, fetchedAt: Date.now() });
    }
  }

  function runSummary(r) {
    return {
      run_id: r.run_id,
      harness: r.harness,
      status: r.status,
      session_id: r.session_id,
      task_id: issueIdOf(r),
      paperclip_run_id: r.paperclip_run_id,
      model: r.runtime?.model || r.model,
      started_at: r.started_at,
      finished_at: r.finished_at,
      duration_ms: r.started_at ? (r.finished_at || Date.now()) - r.started_at : null,
      cost_usd: r.cost_usd || 0,
      usage: r.usage,
      error: r.error,
      preview: (r.error || r.output || "").slice(0, 280),
    };
  }

  function threads(all) {
    const groups = new Map();
    for (const r of all) {
      const key = `${r.harness}\u0000${threadKey(r)}`;
      (groups.get(key) || groups.set(key, []).get(key)).push(r);
    }
    return [...groups.values()].map((rs) => {
      rs.sort((a, b) => (a.started_at || a.updatedAt || 0) - (b.started_at || b.updatedAt || 0));
      const last = rs.at(-1);
      const live = rs.find((r) => !TERMINAL.has(r.status));
      return {
        harness: last.harness,
        key: threadKey(last),
        issue: issueInfo(last.harness, issueIdOf(last)) || (issueIdOf(last) ? { id: issueIdOf(last) } : null),
        runs: rs.length,
        status: live?.status || last.status,
        live_run_id: live?.run_id || null,
        started_at: rs[0].started_at,
        last_at: last.finished_at || last.started_at || last.updatedAt,
        cost_usd: rs.reduce((s, r) => s + (r.cost_usd || 0), 0),
        preview: runSummary(last).preview,
      };
    }).sort((a, b) => (b.live_run_id ? 1 : 0) - (a.live_run_id ? 1 : 0) || (b.last_at || 0) - (a.last_at || 0));
  }

  function readJson(file) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  function agents(all) {
    const dayStart = new Date().setHours(0, 0, 0, 0);
    return Object.entries(RUNNERS).map(([harness, runner]) => {
      const creds = loadCreds(harness);
      const joined = readJson(join_(harness, "join-response.json"));
      const mine = all.filter((r) => r.harness === harness);
      const active = mine.filter((r) => !TERMINAL.has(r.status));
      const daily = Array.from({ length: 14 }, (_, i) => {
        const start = dayStart - (13 - i) * DAY;
        const rs = mine.filter((r) => (r.started_at || 0) >= start && (r.started_at || 0) < start + DAY);
        return { day: start, runs: rs.length, cost_usd: rs.reduce((s, r) => s + (r.cost_usd || 0), 0) };
      });
      const lastSeen = mine.filter((r) => r.runtime?.model).sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0];
      const week = mine.filter((r) => (r.started_at || 0) > dayStart - 6 * DAY);
      return {
        harness,
        provider: runner.provider,
        state: creds?.apiKey ? "hired" : joined?.status === "pending_approval" ? "pending" : joined ? joined.status : "not_joined",
        name: creds?.agentName || joined?.agentName || null,
        agent_id: creds?.agentId || joined?.createdAgentId || null,
        gateway_key: existsSync(join_(harness, "gateway-key")),
        model: process.env[`BRIDGE_${harness.toUpperCase()}_MODEL`] || lastSeen?.runtime?.model || null,
        model_source: process.env[`BRIDGE_${harness.toUpperCase()}_MODEL`] ? "configured" : lastSeen ? "last run" : null,
        running: active.filter((r) => r.status !== "queued").map((r) => ({ ...runSummary(r), issue: issueInfo(harness, issueIdOf(r)) })),
        queued: active.filter((r) => r.status === "queued").length,
        today: daily.at(-1),
        daily,
        week: {
          runs: week.length,
          cost_usd: week.reduce((s, r) => s + (r.cost_usd || 0), 0),
          failed: week.filter((r) => r.status === "failed").length,
        },
        last_active: mine.reduce((m, r) => Math.max(m, r.finished_at || r.started_at || 0), 0) || null,
      };
    });
  }
  const join_ = (harness, file) => join(agentDir(harness), file);

  function state() {
    const all = allRuns();
    const creds = Object.keys(RUNNERS).map(loadCreds).find((c) => c?.apiUrl);
    return {
      gateway: {
        uptime_ms: Date.now() - startedAt,
        started_at: startedAt,
        bind: `${CONFIG.bind}:${CONFIG.port}`,
        workspace: CONFIG.workspace,
        draining: isDraining(),
        public: CONFIG.adminPublic,
        max_concurrency: CONFIG.maxConcurrency,
        paperclip_url: creds?.apiUrl || null,
      },
      agents: agents(all),
      threads: threads(all).slice(0, 300),
      activity: activity.recent(200),
    };
  }

  function partsOf(id) {
    const live = runs.get(id);
    if (live) return { snap: snapshot(live), parts: live.parts, complete: true };
    const snap = history.run(id) || store.run(id);
    if (!snap) throw new HttpError(404, "not_found", "run not found");
    const parts = history.parts(id);
    return { snap, parts: parts.length ? parts : snap.output ? [{ kind: "text", text: snap.output }] : [], complete: parts.length > 0 };
  }

  function thread(harness, key) {
    const rs = allRuns()
      .filter((r) => r.harness === harness && threadKey(r) === key)
      .sort((a, b) => (a.started_at || a.updatedAt || 0) - (b.started_at || b.updatedAt || 0));
    if (!rs.length) throw new HttpError(404, "not_found", "conversation not found");
    const summary = threads(rs)[0];
    return { ...summary, run_list: rs.map((r) => ({ ...runSummary(r), ...pick(partsOf(r.run_id)) })) };
  }
  const pick = ({ parts, complete }) => ({ parts, complete });

  // ---- static -------------------------------------------------------------

  function serveStatic(res, rel) {
    const file = normalize(join(uiDir, rel));
    const target = file.startsWith(uiDir) && existsSync(file) && statSync(file).isFile() ? file : join(uiDir, "index.html");
    if (!existsSync(target)) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Dashboard not built. Run: npm --prefix ui ci && npm --prefix ui run build");
    }
    const immutable = target.includes(`${join(uiDir, "assets")}`);
    res.writeHead(200, { "Content-Type": TYPES[extname(target)] || "application/octet-stream", "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
    res.end(readFileSync(target));
  }

  // ---- routes -------------------------------------------------------------

  const canRead = (req) => CONFIG.adminPublic || Object.keys(RUNNERS).some((h) => authorized(req, h));

  return function handle(req, res, path, url) {
    if (path !== "/admin" && !path.startsWith("/admin/")) return false;
    if (!path.startsWith("/admin/api")) {
      if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "method not allowed");
      serveStatic(res, path.slice("/admin".length).replace(/^\//, "") || "index.html");
      return true;
    }

    const rest = path.slice("/admin/api".length);
    if (req.method === "GET" && rest === "/auth") return send(res, 200, { public: CONFIG.adminPublic, ok: canRead(req) }), true;
    if (!canRead(req)) throw new HttpError(401, "unauthorized", "missing or invalid bearer token");

    if (req.method === "GET" && rest === "/state") return send(res, 200, state()), true;

    let m = rest.match(/^\/threads\/([a-z0-9_-]+)\/(.+)$/);
    if (req.method === "GET" && m) return send(res, 200, thread(m[1], decodeURIComponent(m[2]))), true;

    m = rest.match(/^\/runs\/([^/]+)(\/stop)?$/);
    if (m && req.method === "GET" && !m[2]) {
      const from = Math.max(0, Number(url.searchParams.get("from")) || 0);
      const { snap, parts, complete } = partsOf(decodeURIComponent(m[1]));
      return send(res, 200, { run: runSummary(snap), from, parts: parts.slice(from), total: parts.length, complete }), true;
    }
    if (m && req.method === "POST" && m[2]) {
      const run = runs.get(decodeURIComponent(m[1]));
      if (!run) throw new HttpError(404, "not_found", "run not live");
      if (!authorized(req, run.harness)) throw new HttpError(401, "unauthorized", `stopping needs the ${run.harness} gateway key`);
      if (TERMINAL.has(run.status)) return send(res, 200, { status: run.status }), true;
      if (run.status === "queued") {
        finish(run, "cancelled", "Stopped from the dashboard before it started.");
        return send(res, 200, { status: "cancelled" }), true;
      }
      run.status = "stopping";
      run.stopReason = "Stopped from the dashboard.";
      killRun(run);
      log(`run ${run.id} [${run.harness}] stop requested from the dashboard`);
      return send(res, 200, { status: "stopping" }), true;
    }
    throw new HttpError(404, "not_found", "no such route");
  };
}
