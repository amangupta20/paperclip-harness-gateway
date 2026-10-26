import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CirclePlay, Inbox, Search, Square, XCircle } from "lucide-react";
import type { GatewayState } from "../types";
import { cx } from "./ui";

function kindOf(text: string) {
  if (/warning|error|crashed/i.test(text)) return { Icon: AlertTriangle, cls: "text-warn" };
  if (/\bfailed\b|interrupted/.test(text)) return { Icon: XCircle, cls: "text-bad" };
  if (/\bcompleted\b/.test(text)) return { Icon: CheckCircle2, cls: "text-ok" };
  if (/stop requested|cancelled/.test(text)) return { Icon: Square, cls: "text-mute" };
  if (/\bstarted\b|\bqueued\b/.test(text)) return { Icon: CirclePlay, cls: "text-info" };
  return { Icon: Inbox, cls: "text-faint" };
}

export function Activity({ state }: { state: GatewayState }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => state.activity.filter((a) => !q || a.text.toLowerCase().includes(q.toLowerCase())), [state.activity, q]);
  const g = state.gateway;
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-5 sm:px-6">
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {[
          ["Listening on", g.bind],
          ["Workspace", g.workspace],
          ["Per-agent concurrency", String(g.max_concurrency)],
          ["Dashboard access", g.public ? "Open on this network" : "Gateway key required"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-line bg-surface px-3.5 py-2.5">
            <div className="text-[11px] font-medium tracking-wide text-mute uppercase">{k}</div>
            <div className="mt-0.5 truncate font-mono text-[12.5px]" title={v}>
              {v}
            </div>
          </div>
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-[14px] font-semibold">Gateway log</h2>
          <span className="text-[12px] text-mute">since the last restart, newest first</span>
          <label className="ml-auto flex h-8 w-64 max-w-[45%] items-center gap-2 rounded-lg border border-line bg-bg px-2.5">
            <Search className="h-3.5 w-3.5 text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none" />
          </label>
        </div>
        <ol className="divide-y divide-line">
          {rows.map((a, i) => {
            const k = kindOf(a.text);
            return (
              <li key={`${a.ts}-${i}`} className="flex items-start gap-3 px-4 py-2 font-mono text-[12px]">
                <span className="shrink-0 text-faint tabular-nums">{new Date(a.ts).toLocaleTimeString()}</span>
                <k.Icon className={cx("mt-[2px] h-3.5 w-3.5 shrink-0", k.cls)} />
                <span className="min-w-0 break-words text-fg-2">{a.text}</span>
              </li>
            );
          })}
          {!rows.length && <li className="px-4 py-6 text-center text-[13px] text-mute">No log lines.</li>}
        </ol>
      </div>
    </div>
  );
}
