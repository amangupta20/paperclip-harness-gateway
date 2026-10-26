import { useCallback, useEffect, useRef, useState } from "react";
import type { GatewayState, Part, RunTail, ThreadDetail } from "./types";

const KEY = "gw-key";

export class Unauthorized extends Error {}

export function getKey(): string {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function setKey(k: string) {
  try {
    if (k) localStorage.setItem(KEY, k);
    else localStorage.removeItem(KEY);
  } catch {}
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const k = getKey();
  const res = await fetch(`/admin/api${path}`, {
    ...init,
    headers: { ...(k ? { Authorization: `Bearer ${k}` } : {}), ...(init.headers || {}) },
  });
  if (res.status === 401) throw new Unauthorized((await res.json().catch(() => null))?.error?.message || "unauthorized");
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message || `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  auth: () => call<{ public: boolean; ok: boolean }>("/auth"),
  state: () => call<GatewayState>("/state"),
  thread: (harness: string, key: string) => call<ThreadDetail>(`/threads/${harness}/${encodeURIComponent(key)}`),
  tail: (runId: string, from: number) => call<RunTail>(`/runs/${encodeURIComponent(runId)}?from=${from}`),
  stop: (runId: string) => call<{ status: string }>(`/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" }),
};

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

/** Polls `fn` every `ms` while the tab is visible. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (visible()) await refresh();
      if (alive) timer = setTimeout(loop, ms);
    };
    setData(null);
    loop();
    const onVis = () => visible() && refresh();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, refresh };
}

/** Live parts of one run: fetches incrementally (the last part may still be growing). */
export function useRunTail(runId: string | null, initial?: Part[], live = true) {
  const [parts, setParts] = useState<Part[]>(initial || []);
  const [run, setRun] = useState<RunTail["run"] | null>(null);
  const partsRef = useRef(parts);
  partsRef.current = parts;

  useEffect(() => {
    setParts(initial || []);
    setRun(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      let done = false;
      if (visible()) {
        try {
          const from = Math.max(0, partsRef.current.length - 1);
          const t = await api.tail(runId, from);
          if (!alive) return;
          setParts((prev) => [...prev.slice(0, t.from), ...t.parts]);
          setRun(t.run);
          done = !["queued", "running", "stopping"].includes(t.run.status);
        } catch {}
      }
      if (alive && !done && live) timer = setTimeout(loop, 1000);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runId, live]);

  return { parts, run };
}
