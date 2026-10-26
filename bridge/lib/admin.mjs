// Read-only ops view. GET /admin serves a static page with no data in it; the page
// polls GET /admin/api (and /admin/api/runs/:id for the open run), sending a gateway
// key only if the server asks for one. (EventSource can't send Authorization
// headers, hence polling.)

export const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness Gateway</title>
<style>
  :root { color-scheme: light dark; --bg:#fafafa; --fg:#1d1d1f; --mute:#6e6e73; --line:#e5e5ea; --pick:#eef3fb; --ok:#1a7f37; --bad:#c0362c; --run:#9a6700; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161618; --fg:#ececf0; --mute:#9a9aa2; --line:#2c2c30; --pick:#1f2a3a; --ok:#4ac26b; --bad:#ff7b72; --run:#d29922; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 ui-sans-serif,system-ui,sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:20px 16px; }
  h1 { font-size:18px; margin:0 0 4px; } h2 { font-size:15px; margin:24px 0 0; } .mute { color:var(--mute); }
  table { width:100%; border-collapse:collapse; margin-top:12px; font-size:13px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--mute); font-weight:500; } td.tail { font-family:ui-monospace,monospace; white-space:pre-wrap; word-break:break-word; max-width:380px; }
  #runs tr { cursor:pointer; } #runs tr:hover, #runs tr.pick { background:var(--pick); }
  .s-completed{color:var(--ok)} .s-failed,.s-interrupted{color:var(--bad)} .s-running,.s-queued,.s-stopping{color:var(--run)} .s-cancelled{color:var(--mute)}
  .wrap { overflow-x:auto; } button { font:inherit; }
  #detail { margin-top:12px; border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  #detail[hidden] { display:none; } #detail header { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  .tx { font-family:ui-monospace,monospace; font-size:12.5px; white-space:pre-wrap; word-break:break-word; margin:10px 0 0; }
  .tx .reasoning { color:var(--mute); font-style:italic; } .tx .event { color:var(--mute); }
</style></head><body><main>
<h1>Harness Gateway</h1><div id="meta" class="mute">loading…</div>
<div id="detail" hidden></div>
<div class="wrap"><table><thead><tr><th>Run</th><th>Harness</th><th>Status</th><th>Issue</th><th>Started</th><th>Duration</th><th>Cost</th><th>Output / error</th></tr></thead><tbody id="runs"></tbody></table></div>
<h2>Activity</h2><div class="wrap"><table><tbody id="act"></tbody></table></div>
<p id="keybox" hidden><button id="forget">Forget key</button></p>
</main><script>
const K = "gw-key";
let picked = null, shown = null;
document.getElementById("forget").onclick = () => { sessionStorage.removeItem(K); location.reload(); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" })[c]);
const dur = (ms) => ms == null ? "" : ms < 60000 ? Math.round(ms/1000) + "s" : Math.round(ms/60000) + "m";
const issue = (sk) => (String(sk || "").match(/:issue:([^:]+)$/) || [])[1] || "";
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

async function get(path) {
  const k = sessionStorage.getItem(K);
  const r = await fetch(path, { headers: k ? { Authorization: "Bearer " + k } : {} });
  if (r.status !== 401) return r.json();
  sessionStorage.setItem(K, prompt("Gateway key (any harness)") || "");
  document.getElementById("keybox").hidden = false;
  throw new Error("unauthorized");
}

async function tick() {
  const d = await get("api");
  document.getElementById("keybox").hidden = !d.key_required;
  document.getElementById("meta").textContent = \`up \${dur(d.uptime_ms)} · harnesses \${d.harnesses.join(", ")} · running \${d.running} · queued \${d.queued}\${d.draining ? " · DRAINING" : ""}\`;
  document.getElementById("runs").innerHTML = d.runs.map((x) => \`<tr data-id="\${esc(x.run_id)}" class="\${x.run_id === picked ? "pick" : ""}"><td title="\${esc(x.run_id)}">\${esc(x.run_id.slice(4, 12))}</td><td>\${esc(x.harness)}</td><td class="s-\${esc(x.status)}">\${esc(x.status)}</td><td title="\${esc(x.session_id)}">\${esc(issue(x.session_id) || x.task_id || "").slice(0, 8)}</td><td>\${x.started_at ? new Date(x.started_at).toLocaleString() : ""}</td><td>\${dur(x.duration_ms)}</td><td>\${x.cost_usd ? "$" + x.cost_usd.toFixed(3) : ""}</td><td class="tail">\${esc(x.error || x.output_tail || "")}</td></tr>\`).join("");
  document.getElementById("act").innerHTML = d.activity.map((a) => \`<tr><td class="mute">\${new Date(a.ts).toLocaleTimeString()}</td><td>\${esc(a.text)}</td></tr>\`).join("");
  const open = d.runs.find((x) => x.run_id === picked);
  if (open && (!TERMINAL.has(open.status) || open.status !== shown)) await show(picked);
}

async function show(id) {
  const r = await get("api/runs/" + encodeURIComponent(id));
  const box = document.getElementById("detail");
  const u = r.usage || {};
  shown = r.status;
  box.hidden = false;
  box.innerHTML = \`<header><div><b>\${esc(r.harness)}</b> · <span class="s-\${esc(r.status)}">\${esc(r.status)}</span> · \${esc(r.runtime?.model || r.model || "")}
      \${r.cost_usd ? " · $" + r.cost_usd.toFixed(4) : ""} · in \${u.input_tokens || 0} / cached \${u.cached_input_tokens || 0} / out \${u.output_tokens || 0}</div>
      <button id="close">Close</button></header>
    <div class="mute">\${esc(r.run_id)}\${r.paperclip_run_id ? " · paperclip run " + esc(r.paperclip_run_id) : ""}<br>\${esc(r.session_id || "")}</div>
    \${r.transcript_complete ? "" : '<div class="mute">Older than the buffer window: final output only.</div>'}
    <div class="tx">\${r.transcript.map((t) => \`<span class="\${t.kind}">\${esc(t.kind === "event" ? "\\n[" + t.text + "]\\n" : t.text)}</span>\`).join("")}</div>\`;
  document.getElementById("close").onclick = () => { picked = null; box.hidden = true; tick(); };
}

document.getElementById("runs").onclick = (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  picked = tr.dataset.id;
  document.querySelectorAll("#runs tr").forEach((r) => r.classList.toggle("pick", r === tr));
  show(picked).catch(() => {});
};
tick().catch(() => {}); setInterval(() => tick().catch(() => {}), 2000);
</script></body></html>`;

export function createActivity(limit = 200) {
  const ring = [];
  return {
    push(text) {
      ring.unshift({ ts: Date.now(), text });
      ring.length = Math.min(ring.length, limit);
    },
    recent: (n = 100) => ring.slice(0, n),
  };
}
