import { useEffect, useRef } from "react";
import { ArrowUpRight, Cpu, Hourglass, Moon, Square, UserPlus } from "lucide-react";
import { useRunTail } from "../api";
import type { Agent, GatewayState, Thread } from "../types";
import { ago, duration, usd } from "../format";
import { Transcript } from "./Transcript";
import { issueLabel, issueTitle } from "./ThreadView";
import { AgentAvatar, Button, Kbd, Pill, Spark, Stat, StatusDot, accent, agentMeta, cx } from "./ui";

function AgentState({ a }: { a: Agent }) {
  if (a.state === "pending") return <Pill tone="warn">Awaiting board approval</Pill>;
  if (a.state !== "hired") return <Pill>Not hired</Pill>;
  if (a.running.length) return <Pill tone="info">Working</Pill>;
  if (a.queued) return <Pill tone="warn">{a.queued} queued</Pill>;
  return <Pill tone="ok">Idle</Pill>;
}

function LiveTail({ runId, onStop, onOpen }: { runId: string; onStop: () => void; onOpen: () => void }) {
  const { parts, run } = useRunTail(runId);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [parts]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 text-[12px] text-mute">
        <StatusDot status={run?.status || "running"} />
        <span>Running {run?.started_at ? duration(Date.now() - run.started_at) : ""}</span>
        {run?.model && <span className="truncate font-mono text-[11px] text-faint">{run.model}</span>}
        <span className="ml-auto flex gap-1">
          <Button size="xs" variant="outline" onClick={onOpen}>
            Open <ArrowUpRight className="h-3 w-3" />
          </Button>
          <Button size="xs" variant="danger" onClick={onStop}>
            <Square className="h-2.5 w-2.5 fill-current" /> Stop
          </Button>
        </span>
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <Transcript parts={parts} live showPrompt={false} compact />
      </div>
    </div>
  );
}

function ThreadRow({ t, onOpen }: { t: Thread; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-sunken">
      <StatusDot status={t.status} />
      <span className="shrink-0 font-mono text-[11.5px] text-mute">{issueLabel(t)}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{issueTitle(t)}</span>
      <span className="shrink-0 text-[11.5px] text-faint tabular-nums">{ago(t.last_at)}</span>
    </button>
  );
}

function AgentColumn({ a, threads, onOpen, onStop }: { a: Agent; threads: Thread[]; onOpen: (t: { harness: string; key: string }) => void; onStop: (runId: string) => void }) {
  const m = agentMeta(a.harness);
  const live = a.running[0];
  const liveThread = live && threads.find((t) => t.live_run_id === live.run_id);
  const recent = threads.filter((t) => t.live_run_id !== live?.run_id).slice(0, 8);
  return (
    <section
      style={accent(a.harness)}
      className="flex min-h-[520px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)] lg:h-[calc(100vh-150px)]"
    >
      <div className="h-[3px]" style={{ background: m.color }} />
      <header className="px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-3">
          <AgentAvatar harness={a.harness} size={36} live={!!live} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold">{m.label}</h2>
              <AgentState a={a} />
            </div>
            <div className="truncate text-[12px] text-mute">{a.name || "No Paperclip agent yet"}</div>
          </div>
        </div>
        <div className="mt-3.5 grid grid-cols-3 gap-3">
          <Stat label="Today" value={usd(a.today.cost_usd)} sub={`${a.today.runs} runs`} />
          <Stat label="7 days" value={usd(a.week.cost_usd)} sub={`${a.week.runs} runs${a.week.failed ? ` · ${a.week.failed} failed` : ""}`} />
          <Stat label="Last active" value={<span className="text-[13px]">{ago(a.last_active)}</span>} sub={a.queued ? `${a.queued} queued` : "nothing queued"} />
        </div>
        <div className="mt-3">
          <Spark days={a.daily} color={m.color} />
        </div>
        {a.model && (
          <div className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-mute">
            <Cpu className="h-3 w-3" />
            <span className="truncate font-mono">{a.model}</span>
            <span className="text-faint">({a.model_source})</span>
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col border-t border-line bg-raised">
        {live ? (
          <>
            {liveThread && (
              <button type="button" onClick={() => onOpen(liveThread)} className="flex min-w-0 items-center gap-2 border-b border-line px-4 py-2 text-left hover:bg-sunken">
                <span className="shrink-0 font-mono text-[11.5px]" style={{ color: m.color }}>
                  {issueLabel(liveThread)}
                </span>
                <span className="truncate text-[13px] font-medium">{issueTitle(liveThread)}</span>
              </button>
            )}
            <LiveTail runId={live.run_id} onStop={() => onStop(live.run_id)} onOpen={() => liveThread && onOpen(liveThread)} />
          </>
        ) : a.state === "hired" ? (
          <div className="flex items-center gap-2.5 px-4 py-5 text-[13px] text-mute">
            <Moon className="h-4 w-4 text-faint" />
            <span>Idle. It wakes when Paperclip assigns it work or someone comments on its issues.</span>
          </div>
        ) : a.state === "pending" ? (
          <div className="flex items-start gap-2.5 px-4 py-5 text-[13px] text-mute">
            <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <span>
              Join request sent. Approve it in Paperclip, then run <Kbd>bin/claim-api-key.sh {a.harness}</Kbd>.
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 px-4 py-5 text-[13px] text-mute">
            <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
            <span>
              Not hired. Run <Kbd>bin/join.sh {a.harness} &lt;invite-url&gt;</Kbd>.
            </span>
          </div>
        )}

        <div className={cx("border-t border-line px-2 pt-2.5 pb-2", live ? "max-h-[34%] shrink-0 overflow-y-auto" : "min-h-0 flex-1 overflow-y-auto")}>
          <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-mute uppercase">Recent conversations</div>
          {recent.length ? recent.map((t) => <ThreadRow key={t.key} t={t} onOpen={() => onOpen(t)} />) : <div className="px-2 py-2 text-[12.5px] text-faint">None yet.</div>}
        </div>
      </div>
    </section>
  );
}

export function LiveView({ state, onOpen, onStop }: { state: GatewayState; onOpen: (t: { harness: string; key: string }) => void; onStop: (runId: string, harness: string) => void }) {
  const shown = state.agents.filter((a) => a.state !== "not_joined" || a.running.length || state.threads.some((t) => t.harness === a.harness));
  const idle = state.agents.filter((a) => !shown.includes(a));
  return (
    <div className="mx-auto w-full max-w-[1800px] px-4 py-4 sm:px-6">
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 380px), 1fr))` }}>
        {shown.map((a) => (
          <AgentColumn key={a.harness} a={a} threads={state.threads.filter((t) => t.harness === a.harness)} onOpen={onOpen} onStop={(id) => onStop(id, a.harness)} />
        ))}
      </div>
      {idle.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12.5px] text-mute">
          <span>Also available:</span>
          {idle.map((a) => (
            <span key={a.harness} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1">
              <AgentAvatar harness={a.harness} size={16} /> {agentMeta(a.harness).label}
              <span className="text-faint">· join with</span> <Kbd>bin/join.sh {a.harness} &lt;invite-url&gt;</Kbd>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
