# paperclip-harness-gateway

Run local coding-agent CLIs (**Claude Code**, **pi**, **Codex**) as
[Paperclip](https://github.com/paperclipai/paperclip) agents on your own machine,
with no new Paperclip adapter needed. The gateway speaks the Hermes API-server run
protocol, so in Paperclip each agent is an ordinary `hermes_gateway` agent whose
`apiBaseUrl` points at `http://<this-host>:8787/<harness>`.

Sibling of [dsh-hermes-gateway](https://github.com/amangupta20/dsh-hermes-gateway)
(same contract, for DeepSeek Harness), generalised to pluggable harness runners.

```
Paperclip ── hermes_gateway ──▶ gateway /<harness>/v1/runs ──▶ claude -p | pi -p | codex exec
   ▲                              │  SSE message.delta → live transcript in Paperclip
   └── checkout / comment / PATCH ┘  (agent uses its claimed PAPERCLIP_API_KEY + paperclip skill)
```

Why not Paperclip's `http` adapter? It's fire-and-forget: the heartbeat counts as
"succeeded" as soon as the webhook returns 202, you get no transcript in Paperclip,
and runs can't be stopped. With the Hermes contract you get real run status
(running → completed/failed/timeout), streamed transcripts, usage and cost,
stop/cancel, the full task brief built by Paperclip, and a per-issue `session_id`.
A legacy `POST /wake` endpoint for the `http` adapter is still served, routed to
the `claude` harness.

## Protocol

Modelled on the real Hermes API server (`gateway/platforms/api_server.py` in
NousResearch/hermes-agent) and on what Paperclip's `hermes_gateway` adapter reads.

| Route (also under `/<h>/api/...`) | Auth | Behaviour |
|---|---|---|
| `GET /health`, `/v1/health`, `HEAD *` | none | `{"status":"ok"}` liveness |
| `GET /<h>/health` | bearer | key check (Paperclip's Test Environment) |
| `GET /<h>/health/detailed` | bearer | readiness: credentials, workspace, skill, run counts, draining |
| `GET /<h>/v1/models`, `/v1/capabilities` | bearer | discovery |
| `POST /<h>/v1/runs` | bearer | `{input, instructions?, session_id?, conversation_history?, model?}` → `202 {run_id, status:"started"}` |
| `GET /<h>/v1/runs/:id` | bearer | `{object:"hermes.run", status, session_id, output, error, usage, cost_usd, runtime}` |
| `GET /<h>/v1/runs/:id/events` | bearer | SSE `message.delta`, `reasoning.available`, then `run.completed\|failed\|cancelled\|interrupted` |
| `POST /<h>/v1/runs/:id/stop` | bearer | `{"status":"stopping"}`; kills the process group, settles `cancelled` |
| `GET /admin` (+ `/admin/api`, `/admin/api/runs/:id`) | page: none, data: any gateway key (none with `BRIDGE_ADMIN_PUBLIC=1`) | live runs, activity, and each run's transcript |
| `POST /wake` | claude key | legacy `http` adapter, fire-and-forget |

Behaviour that matches Hermes:
- **Idempotency.** `Idempotency-Key` (Paperclip sends its run id) is kept on disk for 24h. An exact retry gets `202` with `Idempotency-Replayed: true` and the same `run_id`, even after a restart. A different body gets `409 idempotency_key_conflict`.
- **Statuses.** `queued → running → (stopping →) completed | failed | cancelled | interrupted`. Terminal snapshots persist for 24h, so polling after a restart still answers.
- **Shutdown drain.** On SIGTERM, new runs get `503 runtime_draining` with `Retry-After`, and in-flight runs carry `shutdown_requested_at`. After `BRIDGE_DRAIN_MS` they're recorded as `interrupted` and then killed. Runs found active at startup are also `interrupted`.
- **Errors** use `{"error":{"code","message"}}`: `invalid_params` (400), `unauthorized` (401), `rate_limited` (429 once `BRIDGE_MAX_QUEUED` are waiting), `runtime_draining` (503).
- **Usage** is reported under both Hermes names (`cache_read_tokens`, `cache_write_tokens`) and the name Paperclip reads (`cached_input_tokens`). `runtime` names the provider and model that actually served the run.

Tuned for Paperclip's transcript view, which renders only `message.delta`, `reasoning.available` and `run.failed`. Everything else shows up as a bare "Hermes event: X" line:
- Tool calls go inline in the delta text (`▸ Bash: …`) instead of as separate `tool.*` events.
- Model thinking is sent as `reasoning.available`.
- Token-by-token deltas (pi) are merged into ~250 ms chunks.
- `run.failed` carries the exit reason plus the stderr tail.
- Only terminal events carry `status`, because Paperclip treats `status` in any event as terminal.

Other behaviour:
- Runs are serial per session key (= per issue), with `BRIDGE_MAX_CONCURRENCY` (default 1) per harness.
- Harness sessions are remembered per session key, so an issue keeps its context across heartbeats. A stale session falls back to a fresh one.
- SSE reconnects resume from the last event delivered.
- The claimed Paperclip key and the gateway key are redacted from all output.
- Unknown CLI event types are logged once, so output-format drift is visible.

## Layout

| Path | What |
|---|---|
| `bridge/bridge.mjs` | gateway server (Node ≥ 20, no dependencies) |
| `bridge/runners/{claude,pi,codex}.mjs` | per-harness argv + JSONL event parsing |
| `bridge/paperclip-bridge.service` | systemd user unit template |
| `bin/install-service.sh [bind]` | install/restart the service (binds to the Tailscale IPv4 by default) |
| `bin/install-skill.sh [ref]` | fetch Paperclip's `paperclip` skill into `<workspace>/.claude/skills/` |
| `bin/install-session-hook.sh [harness]` | make `claude` started in the workspace act as that agent (see below) |
| `bin/session-env.sh [harness]` | the SessionStart hook it installs |
| `bin/join.sh <harness> <invite-url>` | submit a `hermes_gateway` join request for one harness |
| `bin/claim-api-key.sh <harness>` | claim and verify the API key after board approval |
| `bridge/lib/store.mjs`, `bridge/lib/admin.mjs` | durable state; ops page |
| `test/contract.mjs` | Hermes-contract tests against a real gateway process with a fake harness (`npm test`) |
| `workspace/` | default cwd for every run (override with `BRIDGE_WORKSPACE`) |

Secrets live outside the repo in `~/.paperclip/agents/<harness>/` (0600): `gateway-key`
(the bearer Paperclip sends), `join-*.json`, `claim-response.json`, `credentials.json`.
Run logs are in `~/.paperclip/runs/`.

## Setup

```sh
# optional: run agents somewhere other than ./workspace (the unit and bin/* read this file)
printf 'BRIDGE_WORKSPACE=%s\nBRIDGE_CLONE_DIR=%s\n' ~/projects ~/projects > ~/.paperclip/gateway.env

bin/install-skill.sh "$(curl -s https://<paperclip>/api/health | jq -r .commit)"
bin/install-service.sh                      # tailnet-only by default
sudo ufw allow in on tailscale0 to any port 8787 proto tcp   # if ufw is on

bin/join.sh claude https://<paperclip>/api/invites/<token>/onboarding.txt
# … board approves in Paperclip …
bin/claim-api-key.sh claude                 # picked up without a restart
bin/install-session-hook.sh claude          # optional, see "Interactive sessions"
```

`join.sh` registers `hermes_gateway` with `sessionKeyStrategy: issue`,
`timeoutSec: 3600` (the adapter default is 600) and
`dangerouslyAllowInsecureRemoteHttp: true`. The adapter refuses plain HTTP to
non-loopback hosts otherwise; over Tailscale the link is already WireGuard-encrypted.
For TLS instead, front it with `tailscale serve` and set `BRIDGE_PUBLIC_URL`.
The Paperclip host must be able to route to the gateway address.

### Interactive sessions

`bin/install-session-hook.sh claude` adds a SessionStart hook to
`<workspace>/.claude/settings.json`. A `claude` you start yourself in the workspace then
has the `paperclip` skill, `PAPERCLIP_API_URL`/`_API_KEY`/`_AGENT_ID`/`_COMPANY_ID`
in its Bash env (via `$CLAUDE_ENV_FILE`, never printed), and a note saying which agent it
is. It acts as that agent, so its writes show up in Paperclip as the agent's. With no
heartbeat there's no `PAPERCLIP_RUN_ID`: the server accepts agent-key writes without
`X-Paperclip-Run-Id`, but the skill's helper scripts refuse, so the session uses curl.
Gateway runs already have the env, so the hook does nothing for them. Project skills
and hooks don't reach sessions started in a subfolder, so with `BRIDGE_WORKSPACE=~/projects`
a session in `~/projects/<repo>` is an ordinary one. Don't put a `CLAUDE.md` in the
workspace for this: unlike skills and hooks, `CLAUDE.md` is loaded from parent directories.

### Permissions

Runs are fully autonomous: claude `--dangerously-skip-permissions`, codex
`--dangerously-bypass-approvals-and-sandbox`, and pi has no approval gate. Every run
gets `--add-dir` for `BRIDGE_EXTRA_DIRS` (default `~/projects`). Only connect agents
from a Paperclip company you trust; anyone who can assign them work can run
commands on this machine.

## Configuration

| Env | Default | |
|---|---|---|
| `BRIDGE_BIND` / `BRIDGE_PORT` | `127.0.0.1` / `8787` | the service unit sets the bind |
| `BRIDGE_WORKSPACE` | `./workspace` | cwd for runs; keep it stable so sessions resume |
| `BRIDGE_CLONE_DIR` | `<workspace>/repos` | where agents are told to clone new repos |
| `BRIDGE_EXTRA_DIRS` | `~/projects` | `:`-separated extra dirs (the workspace itself is skipped) |
| `BRIDGE_MAX_CONCURRENCY` | `1` | running runs per harness |
| `BRIDGE_MAX_QUEUED` | `20` | waiting runs per harness before 429 |
| `BRIDGE_DRAIN_MS` | `20000` | shutdown grace before runs are interrupted |
| `BRIDGE_ADMIN_PUBLIC` | — | `1` serves the `/admin` data without a key; only for a private bind such as a tailnet IP, since transcripts contain your task content |
| `BRIDGE_RUN_TIMEOUT_MS` | `3600000` | the gateway's own hard limit |
| `BRIDGE_<HARNESS>_MODEL` | — | e.g. `BRIDGE_PI_MODEL=opencode-go/kimi-k3` |
| `CLAUDE_BIN` / `PI_BIN` / `CODEX_BIN` | on `PATH` | |
| `PAPERCLIP_HOME` | `~/.paperclip` | `gateway.env` there is loaded by the unit and `bin/*` |

## Adding a harness

Drop `bridge/runners/<name>.mjs` exporting `{ name, bin, needsSkillPointer, args(opts), parse(event, out) }`
(plus `provider` and `knownEvents`) and register it in `RUNNERS` in `bridge.mjs`. `args` gets `{prompt, resumeId, sessionKey, workspace, extraDirs, model}`.
`parse` receives each JSONL stdout line and calls `out.delta(text)`, `out.session(id)`, `out.model(m)`,
`out.tool(name, summary)`, `out.reasoning(text)`, `out.provider(p)`, `out.addUsage({...})`, `out.lastText(t)` and `out.result({isError, output, usage, costUsd})`.

Status: `npm test` covers the protocol (10 contract tests). claude and pi have also been run for real through it, including tool calls, reasoning and session resume.
The codex runner follows `codex exec --json` but hasn't been run here yet.
