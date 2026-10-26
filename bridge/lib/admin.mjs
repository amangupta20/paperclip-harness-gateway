// Read-only ops view. GET /admin serves a static page with no data in it; the page
// asks for any harness's gateway key and polls GET /admin/api with it. (EventSource
// can't send Authorization headers, hence polling.)

export const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness Gateway</title>
<style>
  :root { color-scheme: light dark; --bg:#fafafa; --fg:#1d1d1f; --mute:#6e6e73; --line:#e5e5ea; --ok:#1a7f37; --bad:#c0362c; --run:#9a6700; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161618; --fg:#ececf0; --mute:#9a9aa2; --line:#2c2c30; --ok:#4ac26b; --bad:#ff7b72; --run:#d29922; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 ui-sans-serif,system-ui,sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:20px 16px; }
  h1 { font-size:18px; margin:0 0 4px; } .mute { color:var(--mute); }
  table { width:100%; border-collapse:collapse; margin-top:16px; font-size:13px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--mute); font-weight:500; } td.tail { font-family:ui-monospace,monospace; white-space:pre-wrap; word-break:break-word; max-width:420px; }
  .s-completed{color:var(--ok)} .s-failed,.s-interrupted{color:var(--bad)} .s-running,.s-queued,.s-stopping{color:var(--run)} .s-cancelled{color:var(--mute)}
  .wrap { overflow-x:auto; } button { font:inherit; }
</style></head><body><main>
<h1>Harness Gateway</h1><div id="meta" class="mute">loading…</div>
<div class="wrap"><table><thead><tr><th>Run</th><th>Harness</th><th>Status</th><th>Task</th><th>Started</th><th>Duration</th><th>Cost</th><th>Output / error</th></tr></thead><tbody id="runs"></tbody></table></div>
<h2 style="font-size:15px;margin-top:24px">Activity</h2><div class="wrap"><table><tbody id="act"></tbody></table></div>
<p><button id="forget">Forget key</button></p>
</main><script>
const K = "gw-key";
function key() { let k = sessionStorage.getItem(K); if (!k) { k = prompt("Gateway key (any harness)") || ""; sessionStorage.setItem(K, k); } return k; }
document.getElementById("forget").onclick = () => { sessionStorage.removeItem(K); location.reload(); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" })[c]);
const dur = (ms) => ms == null ? "" : ms < 60000 ? Math.round(ms/1000) + "s" : Math.round(ms/60000) + "m";
async function tick() {
  const r = await fetch("api", { headers: { Authorization: "Bearer " + key() } });
  if (r.status === 401) { sessionStorage.removeItem(K); return setTimeout(tick, 500); }
  const d = await r.json();
  document.getElementById("meta").textContent = \`up \${dur(d.uptime_ms)} · harnesses \${d.harnesses.join(", ")} · running \${d.running} · queued \${d.queued}\${d.draining ? " · DRAINING" : ""}\`;
  document.getElementById("runs").innerHTML = d.runs.map((x) => \`<tr><td title="\${esc(x.run_id)}">\${esc(x.run_id.slice(0, 8))}</td><td>\${esc(x.harness)}</td><td class="s-\${esc(x.status)}">\${esc(x.status)}</td><td>\${esc(x.task_id || "")}</td><td>\${x.started_at ? new Date(x.started_at).toLocaleTimeString() : ""}</td><td>\${dur(x.duration_ms)}</td><td>\${x.cost_usd ? "$" + x.cost_usd.toFixed(3) : ""}</td><td class="tail">\${esc(x.error || x.output_tail || "")}</td></tr>\`).join("");
  document.getElementById("act").innerHTML = d.activity.map((a) => \`<tr><td class="mute">\${new Date(a.ts).toLocaleTimeString()}</td><td>\${esc(a.text)}</td></tr>\`).join("");
}
tick(); setInterval(() => tick().catch(() => {}), 2000);
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
