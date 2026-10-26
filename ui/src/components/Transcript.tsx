import { memo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Bot,
  Brain,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Plug,
  ScrollText,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import type { Part } from "../types";
import { cx } from "./ui";

export function toolIcon(name: string) {
  const n = name.toLowerCase();
  if (n.startsWith("mcp")) return Plug;
  if (/bash|shell|exec|command|terminal/.test(n)) return Terminal;
  if (/^(read|view|cat|notebookread)/.test(n)) return FileText;
  if (/edit|write|patch|replace|file_change/.test(n)) return FilePen;
  if (/grep|glob|search|find|^ls$|list/.test(n)) return Search;
  if (/web|fetch|http|browse/.test(n)) return Globe;
  if (/task|agent/.test(n)) return Bot;
  if (/todo|plan/.test(n)) return ListTodo;
  if (/skill/.test(n)) return Sparkles;
  return Wrench;
}

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </Markdown>
    </div>
  );
});

function Disclosure({ summary, children, defaultOpen = false, className }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button type="button" onClick={() => setOpen(!open)} className="group flex w-full min-w-0 items-center gap-1.5 text-left">
        <ChevronRight className={cx("h-3.5 w-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
        {summary}
      </button>
      {open && <div className="fade-in">{children}</div>}
    </div>
  );
}

function ToolRow({ part }: { part: Extract<Part, { kind: "tool" }> }) {
  const Icon = toolIcon(part.name);
  const long = part.text.length > 140 || part.text.includes("\n");
  const [open, setOpen] = useState(false);
  return (
    <div className="group/tool">
      <button
        type="button"
        onClick={() => long && setOpen(!open)}
        className={cx("flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left", long && "hover:bg-sunken")}
      >
        <Icon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-faint" />
        <span className="shrink-0 text-[12.5px] font-medium text-fg-2">{part.name}</span>
        {part.text && (
          <span className={cx("min-w-0 font-mono text-[12px] text-mute", open ? "break-all whitespace-pre-wrap" : "truncate")}>{part.text}</span>
        )}
      </button>
    </div>
  );
}

function ToolGroup({ parts, live }: { parts: Extract<Part, { kind: "tool" }>[]; live: boolean }) {
  const names = [...new Set(parts.map((p) => p.name))];
  if (parts.length <= 2 || live) {
    return (
      <div className="-mx-1.5 my-1">
        {(live && parts.length > 6 ? parts.slice(-6) : parts).map((p, i) => (
          <ToolRow key={i} part={p} />
        ))}
        {live && parts.length > 6 && <div className="px-1.5 text-[11.5px] text-faint">+{parts.length - 6} earlier tool calls</div>}
      </div>
    );
  }
  return (
    <Disclosure
      className="my-1"
      summary={
        <span className="flex min-w-0 items-center gap-2 text-[12.5px] text-mute group-hover:text-fg-2">
          <span className="font-medium">
            {parts.length} tool calls
          </span>
          <span className="flex items-center gap-1 text-faint">
            {names.slice(0, 6).map((n) => {
              const I = toolIcon(n);
              return <I key={n} className="h-3.5 w-3.5" />;
            })}
          </span>
          <span className="truncate text-faint">{names.slice(0, 4).join(", ")}</span>
        </span>
      }
    >
      <div className="mt-1 ml-[7px] border-l border-line pl-2">
        {parts.map((p, i) => (
          <ToolRow key={i} part={p} />
        ))}
      </div>
    </Disclosure>
  );
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const first = text.trim().split("\n")[0].slice(0, 140);
  return (
    <Disclosure
      className="my-1.5"
      defaultOpen={false}
      summary={
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
          <Brain className="h-3.5 w-3.5 shrink-0 text-faint" />
          <span className={cx("shrink-0 font-medium", live ? "shimmer" : "text-mute")}>{live ? "Thinking" : "Thought"}</span>
          <span className="truncate text-faint italic">{first}</span>
        </span>
      }
    >
      <div className="mt-1.5 ml-[7px] border-l border-line pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-mute italic">{text.trim()}</div>
    </Disclosure>
  );
}

export function PromptCard({ text, label = "Wake brief from Paperclip" }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.trim().split("\n");
  return (
    <div className="rounded-xl border border-line bg-raised">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <ScrollText className="h-3.5 w-3.5 text-faint" />
        <span className="text-[12.5px] font-medium text-fg-2">{label}</span>
        <span className="text-[11.5px] text-faint">{lines.length} lines</span>
        <ChevronRight className={cx("ml-auto h-3.5 w-3.5 text-faint transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="fade-in max-h-[60vh] overflow-auto border-t border-line px-3 py-2.5">
          <MarkdownText text={text} />
        </div>
      ) : (
        <div className="relative max-h-[3.6em] overflow-hidden px-3 pb-2 font-mono text-[11.5px] leading-[1.2em] text-mute">
          {lines.slice(0, 3).join("\n")}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-raised" />
        </div>
      )}
    </div>
  );
}

type Block =
  | { type: "prompt"; text: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tools"; parts: Extract<Part, { kind: "tool" }>[] }
  | { type: "error"; text: string };

function blocks(parts: Part[]): Block[] {
  const out: Block[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (p.kind === "tool") {
      if (last?.type === "tools") last.parts.push(p);
      else out.push({ type: "tools", parts: [p] });
    } else if (p.kind === "text") {
      // Tool lines are interleaved as their own parts; skip whitespace-only text between them.
      if (!p.text.trim()) continue;
      if (last?.type === "text") last.text += p.text;
      else out.push({ type: "text", text: p.text });
    } else out.push({ type: p.kind, text: p.text } as Block);
  }
  return out;
}

export function Transcript({ parts, live, showPrompt = true, compact = false }: { parts: Part[]; live: boolean; showPrompt?: boolean; compact?: boolean }) {
  const bs = blocks(parts).filter((b) => showPrompt || b.type !== "prompt");
  return (
    <div className={cx("flex flex-col", compact ? "gap-1.5" : "gap-2.5")}>
      {bs.map((b, i) => {
        const isLast = i === bs.length - 1;
        if (b.type === "prompt") return <PromptCard key={i} text={b.text} />;
        if (b.type === "text") return <MarkdownText key={i} text={b.text} />;
        if (b.type === "reasoning") return <Reasoning key={i} text={b.text} live={live && isLast} />;
        if (b.type === "tools") return <ToolGroup key={i} parts={b.parts} live={live && isLast} />;
        return (
          <div key={i} className="flex gap-2 rounded-lg border border-bad/25 bg-bad-bg px-3 py-2 text-[13px] text-bad">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <pre className="min-w-0 font-mono text-[12px] break-words whitespace-pre-wrap">{b.text}</pre>
          </div>
        );
      })}
      {live && (
        <div className="flex items-center gap-2 py-1 text-[12.5px]">
          <span className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full" style={{ background: "var(--accent)", animationDelay: `${i * 120}ms` }} />
            ))}
          </span>
          <span className="shimmer font-medium">Working</span>
        </div>
      )}
    </div>
  );
}
