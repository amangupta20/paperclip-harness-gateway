import { useMemo, useState } from "react";
import { MessagesSquare, Search } from "lucide-react";
import type { GatewayState, Thread } from "../types";
import { ago, usd } from "../format";
import { ThreadView, issueLabel, issueTitle } from "./ThreadView";
import { AgentAvatar, Empty, StatusDot, agentMeta, cx } from "./ui";

type Filter = "all" | "live" | "failed";

function ThreadItem({ t, active, onClick }: { t: Thread; active: boolean; onClick: () => void }) {
  const m = agentMeta(t.harness);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "relative flex w-full min-w-0 gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
        active ? "bg-sunken" : "hover:bg-sunken/60",
      )}
    >
      {active && <span className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-full" style={{ background: m.color }} />}
      <AgentAvatar harness={t.harness} size={26} live={!!t.live_run_id} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11.5px] font-medium" style={{ color: m.color }}>
            {issueLabel(t)}
          </span>
          <StatusDot status={t.status} />
          <span className="ml-auto shrink-0 text-[11.5px] text-faint tabular-nums">{ago(t.last_at)}</span>
        </div>
        <div className="truncate text-[13px] font-medium text-fg">{issueTitle(t)}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-mute">
          <span className="truncate">{t.preview ? t.preview.replace(/\s+/g, " ").slice(0, 90) : "—"}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-faint tabular-nums">
          <span>
            {t.runs} {t.runs === 1 ? "run" : "runs"}
          </span>
          <span>·</span>
          <span>{usd(t.cost_usd)}</span>
          {t.issue?.status && (
            <>
              <span>·</span>
              <span>{t.issue.status.replace(/_/g, " ")}</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

export function Conversations({
  state,
  selected,
  onSelect,
  onStop,
}: {
  state: GatewayState;
  selected: { harness: string; key: string } | null;
  onSelect: (t: { harness: string; key: string } | null) => void;
  onStop: (runId: string, harness: string) => void;
}) {
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState<string>("all");
  const [filter, setFilter] = useState<Filter>("all");
  const harnesses = [...new Set(state.threads.map((t) => t.harness))];

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return state.threads.filter(
      (t) =>
        (agent === "all" || t.harness === agent) &&
        (filter === "all" || (filter === "live" ? !!t.live_run_id : t.status === "failed" || t.status === "interrupted")) &&
        (!needle || [issueLabel(t), issueTitle(t), t.preview, t.key].some((s) => s?.toLowerCase().includes(needle))),
    );
  }, [state.threads, q, agent, filter]);

  const current = selected && state.threads.find((t) => t.harness === selected.harness && t.key === selected.key);

  return (
    <div className="mx-auto flex h-[calc(100vh-57px)] w-full max-w-[1800px] min-h-0">
      <aside className={cx("flex w-full min-h-0 flex-col border-r border-line bg-bg lg:w-[380px] lg:shrink-0", selected && "hidden lg:flex")}>
        <div className="space-y-2.5 border-b border-line p-3">
          <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 focus-within:border-line-strong">
            <Search className="h-4 w-4 text-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search issues, titles, output…"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            {["all", ...harnesses].map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setAgent(h)}
                className={cx(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium",
                  agent === h ? "border-transparent bg-fg text-bg" : "border-line bg-surface text-fg-2 hover:border-line-strong",
                )}
              >
                {h !== "all" && <span className="h-2 w-2 rounded-full" style={{ background: agentMeta(h).color }} />}
                {h === "all" ? "All agents" : agentMeta(h).label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 rounded-lg bg-sunken p-0.5">
            {(["all", "live", "failed"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cx(
                  "h-7 flex-1 rounded-md text-[12px] font-medium",
                  filter === f ? "bg-surface text-fg shadow-[0_0_0_1px_var(--c-line)]" : "text-mute hover:text-fg-2",
                )}
              >
                {f === "all" ? "Any status" : f === "live" ? "Running" : "Failed"}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {list.length ? (
            list.map((t) => (
              <ThreadItem
                key={`${t.harness}:${t.key}`}
                t={t}
                active={!!selected && selected.harness === t.harness && selected.key === t.key}
                onClick={() => onSelect({ harness: t.harness, key: t.key })}
              />
            ))
          ) : (
            <Empty icon={MessagesSquare} title={state.threads.length ? "Nothing matches" : "No conversations yet"}>
              {state.threads.length ? "Try another filter." : "Conversations appear here once Paperclip wakes an agent."}
            </Empty>
          )}
        </div>
      </aside>
      <main className={cx("min-h-0 min-w-0 flex-1", !selected && "hidden lg:block")}>
        {selected ? (
          <ThreadView
            key={`${selected.harness}:${selected.key}`}
            harness={selected.harness}
            threadKey={selected.key}
            summary={current || undefined}
            paperclipUrl={state.gateway.paperclip_url}
            onBack={() => onSelect(null)}
            onStop={onStop}
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-surface">
            <Empty icon={MessagesSquare} title="Pick a conversation">
              Each Paperclip issue is one conversation. The agent keeps its session across every wake on that issue.
            </Empty>
          </div>
        )}
      </main>
    </div>
  );
}
