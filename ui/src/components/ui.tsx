import type { CSSProperties, ReactNode } from "react";
import { Ban, CheckCircle2, CircleDashed, CircleSlash, Loader2, OctagonX, PauseCircle, XCircle } from "lucide-react";
import type { Day, RunStatus } from "../types";
import { usd } from "../format";

export const AGENTS: Record<string, { label: string; color: string; glyph: string }> = {
  claude: { label: "Claude Code", color: "var(--c-claude)", glyph: "C" },
  pi: { label: "pi", color: "var(--c-pi)", glyph: "π" },
  codex: { label: "Codex", color: "var(--c-codex)", glyph: "X" },
  fake: { label: "Fake", color: "var(--c-fake)", glyph: "F" },
};
export const agentMeta = (h: string) => AGENTS[h] || { label: h, color: "var(--c-fake)", glyph: h[0]?.toUpperCase() || "?" };
export const accent = (h: string) => ({ "--accent": agentMeta(h).color }) as CSSProperties;

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function AgentAvatar({ harness, size = 28, live = false }: { harness: string; size?: number; live?: boolean }) {
  const m = agentMeta(harness);
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span
        className="inline-flex h-full w-full items-center justify-center rounded-[28%] font-semibold text-white shadow-sm"
        style={{ background: `linear-gradient(145deg, color-mix(in oklab, ${m.color} 88%, white), ${m.color})`, fontSize: size * 0.46 }}
      >
        {m.glyph}
      </span>
      {live && (
        <span className="absolute -right-0.5 -bottom-0.5 flex h-2.5 w-2.5 rounded-full border-2 border-surface bg-ok text-ok">
          <span className="live-dot h-full w-full rounded-full" />
        </span>
      )}
    </span>
  );
}

export function AgentChip({ harness }: { harness: string }) {
  const m = agentMeta(harness);
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
      <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}

const STATUS: Record<RunStatus, { label: string; cls: string; Icon: typeof CheckCircle2; spin?: boolean }> = {
  queued: { label: "Queued", cls: "text-mute bg-sunken", Icon: CircleDashed },
  running: { label: "Running", cls: "text-info bg-info-bg", Icon: Loader2, spin: true },
  stopping: { label: "Stopping", cls: "text-warn bg-warn-bg", Icon: Loader2, spin: true },
  completed: { label: "Completed", cls: "text-ok bg-ok-bg", Icon: CheckCircle2 },
  failed: { label: "Failed", cls: "text-bad bg-bad-bg", Icon: XCircle },
  cancelled: { label: "Cancelled", cls: "text-mute bg-sunken", Icon: Ban },
  interrupted: { label: "Interrupted", cls: "text-warn bg-warn-bg", Icon: PauseCircle },
};

export function StatusBadge({ status, compact = false }: { status: RunStatus; compact?: boolean }) {
  const s = STATUS[status] || { label: status, cls: "text-mute bg-sunken", Icon: CircleSlash };
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap", compact ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-0.5 text-[12px]", s.cls)}>
      <s.Icon className={cx("h-3 w-3", s.spin && "animate-spin")} strokeWidth={2.4} />
      {s.label}
    </span>
  );
}

export function StatusDot({ status }: { status: RunStatus }) {
  const color =
    status === "running" || status === "stopping"
      ? "bg-info text-info"
      : status === "completed"
        ? "bg-ok"
        : status === "failed"
          ? "bg-bad"
          : status === "interrupted"
            ? "bg-warn"
            : "bg-faint";
  const live = status === "running" || status === "stopping";
  return <span className={cx("inline-block h-2 w-2 shrink-0 rounded-full", color, live && "live-dot")} title={status} />;
}

export function Pill({ children, tone = "mute", title }: { children: ReactNode; tone?: "mute" | "ok" | "bad" | "warn" | "info"; title?: string }) {
  const cls = { mute: "bg-sunken text-mute", ok: "bg-ok-bg text-ok", bad: "bg-bad-bg text-bad", warn: "bg-warn-bg text-warn", info: "bg-info-bg text-info" }[tone];
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap", cls)}>
      {children}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium tracking-wide text-mute uppercase">{label}</div>
      <div className="mt-0.5 truncate text-[15px] font-semibold tabular-nums">{value}</div>
      {sub && <div className="truncate text-[11.5px] text-mute">{sub}</div>}
    </div>
  );
}

/** 14-day cost bars, tinted with the agent colour. */
export function Spark({ days, color }: { days: Day[]; color: string }) {
  const max = Math.max(...days.map((d) => d.cost_usd), 0.0001);
  return (
    <div className="flex h-8 items-end gap-[3px]" aria-label="cost per day, last 14 days">
      {days.map((d, i) => (
        <div
          key={d.day}
          className="group relative flex-1 rounded-[2px]"
          style={{
            height: `${Math.max(d.runs ? 12 : 4, (d.cost_usd / max) * 100)}%`,
            background: d.runs ? color : "var(--c-line)",
            opacity: d.runs ? (i === days.length - 1 ? 1 : 0.55) : 1,
          }}
          title={`${new Date(d.day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${d.runs} runs, ${usd(d.cost_usd)}`}
        />
      ))}
    </div>
  );
}

export function Empty({ icon: Icon = OctagonX, title, children }: { icon?: typeof OctagonX; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-raised text-faint">
        <Icon className="h-5 w-5" />
      </div>
      <div className="font-medium text-fg-2">{title}</div>
      {children && <div className="mt-1 max-w-sm text-[13px] text-mute">{children}</div>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "ghost",
  size = "sm",
  title,
  disabled,
  href,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "ghost" | "outline" | "danger" | "primary";
  size?: "sm" | "xs";
  title?: string;
  disabled?: boolean;
  href?: string;
}) {
  const cls = cx(
    "inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
    size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-6 px-2 text-[12px]",
    variant === "ghost" && "text-fg-2 hover:bg-sunken hover:text-fg",
    variant === "outline" && "border border-line bg-surface text-fg-2 hover:border-line-strong hover:text-fg",
    variant === "danger" && "border border-line bg-surface text-bad hover:bg-bad-bg hover:border-transparent",
    variant === "primary" && "bg-fg text-bg hover:opacity-90",
  );
  if (href)
    return (
      <a className={cls} href={href} target="_blank" rel="noreferrer" title={title}>
        {children}
      </a>
    );
  return (
    <button className={cls} onClick={onClick} title={title} disabled={disabled} type="button">
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <code className="rounded border border-line bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-fg-2">{children}</code>;
}
