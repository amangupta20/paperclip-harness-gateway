export type RunStatus = "queued" | "running" | "stopping" | "completed" | "failed" | "cancelled" | "interrupted";

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cached_input_tokens: number;
};

export type Issue = {
  id: string;
  identifier?: string | null;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  url?: string | null;
  error?: string;
};

export type RunSummary = {
  run_id: string;
  harness: string;
  status: RunStatus;
  session_id?: string;
  task_id?: string;
  paperclip_run_id?: string;
  model?: string;
  started_at?: number;
  finished_at?: number;
  duration_ms: number | null;
  cost_usd: number;
  usage?: Usage;
  error?: string;
  preview: string;
};

export type Part =
  | { kind: "prompt"; text: string; ts: number }
  | { kind: "text"; text: string; ts: number }
  | { kind: "reasoning"; text: string; ts: number }
  | { kind: "tool"; name: string; text: string; ts: number }
  | { kind: "error"; text: string; ts: number; status?: RunStatus };

export type Day = { day: number; runs: number; cost_usd: number };

export type Agent = {
  harness: string;
  provider: string;
  state: "hired" | "pending" | "not_joined" | string;
  name: string | null;
  agent_id: string | null;
  gateway_key: boolean;
  model: string | null;
  model_source: "configured" | "last run" | null;
  running: (RunSummary & { issue: Issue | null })[];
  queued: number;
  today: Day;
  daily: Day[];
  week: { runs: number; cost_usd: number; failed: number };
  last_active: number | null;
};

export type Thread = {
  harness: string;
  key: string;
  issue: Issue | null;
  runs: number;
  status: RunStatus;
  live_run_id: string | null;
  started_at?: number;
  last_at?: number;
  cost_usd: number;
  preview: string;
};

export type ThreadDetail = Thread & { run_list: (RunSummary & { parts: Part[]; complete: boolean })[] };

export type GatewayState = {
  gateway: {
    uptime_ms: number;
    started_at: number;
    bind: string;
    workspace: string;
    draining: boolean;
    public: boolean;
    max_concurrency: number;
    paperclip_url: string | null;
  };
  agents: Agent[];
  threads: Thread[];
  activity: { ts: number; text: string }[];
};

export type RunTail = { run: RunSummary; from: number; parts: Part[]; total: number; complete: boolean };
