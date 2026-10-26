import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, Clock, Coins, ExternalLink, Hash, Layers, OctagonX, Square } from "lucide-react";
import { api, useRunTail } from "../api";
import type { Thread, ThreadDetail } from "../types";
import { clock, duration, isLive, shortId, tokens, usd, ago } from "../format";
import { Transcript } from "./Transcript";
import { AgentAvatar, Button, Empty, Pill, StatusBadge, accent, agentMeta, cx } from "./ui";

type RunEntry = ThreadDetail["run_list"][number];

export function issueLabel(t: Pick<Thread, "issue" | "key">) {
  if (t.issue?.identifier) return t.issue.identifier;
  if (t.issue?.id) return t.issue.id.slice(0, 8);
  return "No issue";
}

export function issueTitle(t: Pick<Thread, "issue" | "key" | "preview">) {
  return t.issue?.title || (t.issue ? t.preview?.split("\n")[0] || "Untitled" : `Wake without a task: ${t.preview?.split("\n")[0] || "no output"}`);
}

function RunHeader({ run, index, paperclipUrl, onStop }: { run: RunEntry; index: number; paperclipUrl?: string | null; onStop: () => void }) {
  const live = isLive(run.status);
  const u = run.usage;
  return (
    <div className="sticky top-0 z-10 -mx-5 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface/90 px-5 py-2 backdrop-blur">
      <span className="text-[12px] font-semibold text-fg">Run {index + 1}</span>
      <StatusBadge status={run.status} compact />
      <span className="flex items-center gap-1 text-[12px] text-mute">
        <Clock className="h-3 w-3" />
        {clock(run.started_at)}
        {run.duration_ms != null && <span className="text-faint">· {duration(run.duration_ms)}</span>}
      </span>
      {run.model && <span className="font-mono text-[11.5px] text-mute">{run.model}</span>}
      {run.cost_usd > 0 && <span className="text-[12px] text-mute tabular-nums">{usd(run.cost_usd, 3)}</span>}
      {u && u.total_tokens > 0 && (
        <span
          className="text-[11.5px] text-faint tabular-nums"
          title={`input ${u.input_tokens} · cache read ${u.cache_read_tokens} · cache write ${u.cache_write_tokens} · output ${u.output_tokens}`}
        >
          {tokens(u.input_tokens)} in · {tokens(u.cache_read_tokens)} cached · {tokens(u.output_tokens)} out
        </span>
      )}
      <span className="ml-auto flex items-center gap-1">
        <span className="font-mono text-[11px] text-faint" title={run.run_id}>
          {shortId(run.run_id)}
        </span>
        {paperclipUrl && run.paperclip_run_id && (
          <Button size="xs" href={paperclipUrl} title="Open this run in Paperclip">
            <ExternalLink className="h-3 w-3" />
          </Button>
        )}
        {live && (
          <Button size="xs" variant="danger" onClick={onStop} title="Stop this run">
            <Square className="h-3 w-3 fill-current" /> Stop
          </Button>
        )}
      </span>
    </div>
  );
}

function RunSection({ run, index, isLast, paperclipUrl, onStop }: { run: RunEntry; index: number; isLast: boolean; paperclipUrl?: string | null; onStop: (id: string) => void }) {
  const live = isLive(run.status);
  const tail = useRunTail(live ? run.run_id : null, run.parts, live);
  const parts = live ? tail.parts : run.parts;
  const status = tail.run?.status || run.status;
  return (
    <section className={cx("px-5 pb-6", !isLast && "border-b border-line")}>
      <RunHeader run={{ ...run, ...(tail.run || {}), status }} index={index} paperclipUrl={paperclipUrl} onStop={() => onStop(run.run_id)} />
      {!run.complete && !live && <div className="mb-2 text-[12px] text-faint">Full transcript wasn't recorded for this run; showing its final output.</div>}
      <Transcript parts={parts} live={isLive(status)} />
    </section>
  );
}

export function ThreadView({
  harness,
  threadKey,
  summary,
  paperclipUrl,
  onBack,
  onStop,
}: {
  harness: string;
  threadKey: string;
  summary?: Thread;
  paperclipUrl?: string | null;
  onBack?: () => void;
  onStop: (runId: string, harness: string) => void;
}) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  atBottomRef.current = atBottom;
  const sig = summary ? `${summary.runs}:${summary.status}:${summary.live_run_id}` : "";

  useEffect(() => {
    setDetail(null);
    setError(null);
  }, [harness, threadKey]);

  useEffect(() => {
    let alive = true;
    api
      .thread(harness, threadKey)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [harness, threadKey, sig]);

  // Follow the live tail while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const obs = new MutationObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, [detail?.key]);

  useEffect(() => {
    const el = scroller.current;
    if (el && detail) el.scrollTop = el.scrollHeight;
  }, [detail?.key]);

  const t = detail || summary;
  const m = agentMeta(harness);
  const issueUrl = t?.issue?.url;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" style={accent(harness)}>
      <header className="flex items-start gap-3 border-b border-line px-5 py-3.5">
        {onBack && (
          <button type="button" onClick={onBack} className="-ml-1 mt-1 rounded-md p-1 text-mute hover:bg-sunken lg:hidden">
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <AgentAvatar harness={harness} size={34} live={!!t?.live_run_id} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {t && (
              <span className="font-mono text-[12px] font-medium" style={{ color: m.color }}>
                {issueLabel(t)}
              </span>
            )}
            {t?.issue?.status && <Pill>{t.issue.status.replace(/_/g, " ")}</Pill>}
            {t?.issue?.priority && <Pill>{t.issue.priority}</Pill>}
          </div>
          <h2 className="mt-0.5 truncate text-[16px] leading-snug font-semibold">{t ? issueTitle(t) : "Loading…"}</h2>
          {t && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-mute">
              <span>{m.label}</span>
              <span className="flex items-center gap-1">
                <Layers className="h-3 w-3" />
                {t.runs} {t.runs === 1 ? "run" : "runs"}
              </span>
              <span className="flex items-center gap-1 tabular-nums">
                <Coins className="h-3 w-3" />
                {usd(t.cost_usd)}
              </span>
              <span>updated {ago(t.last_at)}</span>
              {t.issue && (
                <span className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-faint" title={t.key}>
                  <Hash className="h-3 w-3" />
                  <span className="truncate">session per issue</span>
                </span>
              )}
            </div>
          )}
        </div>
        {issueUrl && (
          <Button variant="outline" href={issueUrl} title="Open the issue in Paperclip">
            <ExternalLink className="h-3.5 w-3.5" /> Paperclip
          </Button>
        )}
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        {error && (
          <Empty icon={OctagonX} title="Couldn't load this conversation">
            {error}
          </Empty>
        )}
        {!detail && !error && <div className="p-6 text-[13px] text-mute">Loading conversation…</div>}
        {detail?.run_list.map((r, i) => (
          <RunSection
            key={r.run_id}
            run={r}
            index={i}
            isLast={i === detail.run_list.length - 1}
            paperclipUrl={paperclipRunUrl(paperclipUrl, detail, r)}
            onStop={(id) => onStop(id, harness)}
          />
        ))}
      </div>

      {!atBottom && detail && (
        <div className="pointer-events-none relative">
          <button
            type="button"
            onClick={() => scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight)}
            className="pointer-events-auto absolute right-5 bottom-4 flex items-center gap-1 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-fg-2 shadow-lg hover:text-fg"
          >
            <ArrowDown className="h-3.5 w-3.5" /> Latest
          </button>
        </div>
      )}
    </div>
  );
}

function paperclipRunUrl(base: string | null | undefined, t: ThreadDetail, r: RunEntry) {
  const prefix = t.issue?.identifier?.split("-")[0];
  const agentId = r.session_id?.match(/:agent:([^:]+)/)?.[1];
  if (!base || !prefix || !agentId || !r.paperclip_run_id) return null;
  return `${base}/${prefix}/agents/${agentId}/runs/${r.paperclip_run_id}`;
}
