import { useCallback, useEffect, useState } from "react";
import { Activity as ActivityIcon, ExternalLink, LayoutGrid, Lock, MessagesSquare, Monitor, Moon, Sun, Unlock, WifiOff } from "lucide-react";
import { Unauthorized, api, setKey, usePoll } from "./api";
import { duration } from "./format";
import { Activity } from "./components/Activity";
import { Conversations } from "./components/Conversations";
import { KeyDialog } from "./components/KeyDialog";
import { LiveView } from "./components/LiveView";
import { Button, cx } from "./components/ui";

type Route = { view: "live" } | { view: "conversations"; harness?: string; key?: string } | { view: "activity" };

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("activity")) return { view: "activity" };
  if (h.startsWith("c")) {
    const [, harness, ...key] = h.split("/");
    return { view: "conversations", harness: harness || undefined, key: key.length ? decodeURIComponent(key.join("/")) : undefined };
  }
  return { view: "live" };
}

const go = (r: Route) => {
  location.hash =
    r.view === "live" ? "/" : r.view === "activity" ? "/activity" : r.harness && r.key ? `/c/${r.harness}/${encodeURIComponent(r.key)}` : "/c";
};

type Theme = "system" | "light" | "dark";
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("theme") as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && mq.matches));
    apply();
    try {
      localStorage.setItem("theme", theme);
    } catch {}
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  return [theme, () => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")] as const;
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [theme, cycleTheme] = useTheme();
  const [keyPrompt, setKeyPrompt] = useState<{ reason: string; then?: () => void } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { data: state, error, refresh } = usePoll(api.state, 2000, []);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    if (error instanceof Unauthorized && !keyPrompt) setKeyPrompt({ reason: "This dashboard needs any agent's gateway key to show its data." });
  }, [error, keyPrompt]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const stop = useCallback(
    async (runId: string, harness: string) => {
      if (!confirm("Stop this run? The agent is killed mid-task and Paperclip records the run as cancelled.")) return;
      const attempt = async () => {
        try {
          const r = await api.stop(runId);
          setToast(r.status === "stopping" ? "Stopping the run…" : `Run is ${r.status}`);
          refresh();
        } catch (e) {
          if (e instanceof Unauthorized) setKeyPrompt({ reason: `Stopping a run needs the ${harness} gateway key, even when viewing is open.`, then: attempt });
          else setToast(`Stop failed: ${(e as Error).message}`);
        }
      };
      attempt();
    },
    [refresh],
  );

  const tabs = [
    { view: "live", label: "Live", Icon: LayoutGrid },
    { view: "conversations", label: "Conversations", Icon: MessagesSquare },
    { view: "activity", label: "Activity", Icon: ActivityIcon },
  ] as const;
  const running = state?.agents.reduce((n, a) => n + a.running.length, 0) || 0;
  const offline = error && !(error instanceof Unauthorized);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-[1800px] items-center gap-3 px-4 sm:px-6">
          <a href="#/" className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-fg">
              <svg viewBox="0 0 32 32" className="h-4 w-4">
                <path d="M7 10h18M7 16h11M7 22h18" stroke="var(--c-claude)" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </span>
            <span className="hidden text-[14px] font-semibold tracking-tight sm:block">Harness Gateway</span>
          </a>
          <nav className="ml-2 flex items-center gap-0.5 rounded-xl border border-line bg-surface p-0.5">
            {tabs.map(({ view, label, Icon }) => (
              <button
                key={view}
                type="button"
                onClick={() => go({ view } as Route)}
                className={cx(
                  "flex h-8 items-center gap-1.5 rounded-[10px] px-2.5 text-[13px] font-medium transition-colors",
                  route.view === view ? "bg-sunken text-fg shadow-[inset_0_0_0_1px_var(--c-line)]" : "text-mute hover:text-fg-2",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{label}</span>
                {view === "live" && running > 0 && <span className="rounded-full bg-info-bg px-1.5 text-[11px] text-info tabular-nums">{running}</span>}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            {state && (
              <span className="hidden items-center gap-2 rounded-lg px-2 text-[12px] text-mute md:flex" title={`listening on ${state.gateway.bind}`}>
                <span className={cx("h-2 w-2 rounded-full", state.gateway.draining ? "bg-warn" : "bg-ok")} />
                {state.gateway.draining ? "Draining" : `Up ${duration(state.gateway.uptime_ms)}`}
              </span>
            )}
            {offline && (
              <span className="flex items-center gap-1.5 rounded-lg bg-bad-bg px-2 py-1 text-[12px] font-medium text-bad">
                <WifiOff className="h-3.5 w-3.5" /> Gateway unreachable
              </span>
            )}
            {state && (
              <span
                className="hidden items-center gap-1 rounded-lg px-2 text-[12px] text-mute lg:flex"
                title={state.gateway.public ? "Anyone who can reach the gateway can view this dashboard; stopping runs still needs a key." : "Viewing needs a gateway key."}
              >
                {state.gateway.public ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                {state.gateway.public ? "Open" : "Key required"}
              </span>
            )}
            {state?.gateway.paperclip_url && (
              <Button variant="outline" href={state.gateway.paperclip_url}>
                Paperclip <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button onClick={cycleTheme} title={`Theme: ${theme}`}>
              {theme === "dark" ? <Moon className="h-4 w-4" /> : theme === "light" ? <Sun className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {!state ? (
          <div className="flex h-[60vh] items-center justify-center text-[13px] text-mute">{offline ? "Can't reach the gateway. Retrying…" : "Loading…"}</div>
        ) : route.view === "live" ? (
          <LiveView state={state} onOpen={(t) => go({ view: "conversations", harness: t.harness, key: t.key })} onStop={stop} />
        ) : route.view === "conversations" ? (
          <Conversations
            state={state}
            selected={route.harness && route.key ? { harness: route.harness, key: route.key } : null}
            onSelect={(t) => go(t ? { view: "conversations", ...t } : { view: "conversations" })}
            onStop={stop}
          />
        ) : (
          <Activity state={state} />
        )}
      </div>

      {keyPrompt && (
        <KeyDialog
          reason={keyPrompt.reason}
          onCancel={keyPrompt.then ? () => setKeyPrompt(null) : undefined}
          onSave={(k) => {
            setKey(k);
            const then = keyPrompt.then;
            setKeyPrompt(null);
            refresh();
            then?.();
          }}
        />
      )}
      {toast && (
        <div className="fade-in fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-line bg-surface px-4 py-2.5 text-[13px] shadow-xl">{toast}</div>
      )}
    </div>
  );
}
