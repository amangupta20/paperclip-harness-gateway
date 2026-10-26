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

| Route (also under `/<h>/api/...`) | Auth | Behaviour |
|---|---|---|
| `HEAD *`, `GET /health` | none | liveness |
| `GET /<h>/health` | bearer | key check (Paperclip's Test Environment) |
| `POST /<h>/v1/runs` | bearer | `{input, instructions, session_id}` → `{run_id}`; `Idempotency-Key` (= Paperclip run id) dedupes |
| `GET /<h>/v1/runs/:id` | bearer | `{status, output, error, usage, cost_usd, model, session_id}` |
| `GET /<h>/v1/runs/:id/events` | bearer | SSE: `message.delta` …, then `run.completed` / `run.failed` / `run.cancelled` |
| `POST /<h>/v1/runs/:id/stop` | bearer | kills the run's whole process group, settles `cancelled` |

- Runs are serial per Paperclip session key (= per issue), with `BRIDGE_MAX_CONCURRENCY` (default 1) per harness.
- The harness session for each session key is remembered (`--resume` for claude/codex, deterministic `--session-id` for pi), so an issue keeps its context across heartbeats.
- Reconnecting SSE resumes from the last event delivered.
- Only the terminal event carries `status`: Paperclip treats `status` in any event as terminal.
- Runs that were active when the gateway restarted answer `failed` instead of 404, so Paperclip doesn't poll them until its timeout.
- The claimed Paperclip key and the gateway key are redacted from transcripts and output.

## Layout

| Path | What |
|---|---|
| `bridge/bridge.mjs` | gateway server (Node ≥ 20, no dependencies) |
| `bridge/runners/{claude,pi,codex}.mjs` | per-harness argv + JSONL event parsing |
| `bridge/paperclip-bridge.service` | systemd user unit template |
| `bin/install-service.sh [bind]` | install/restart the service (binds to the Tailscale IPv4 by default) |
| `bin/install-skill.sh [ref]` | fetch Paperclip's `paperclip` skill into `workspace/.claude/skills/` |
| `bin/join.sh <harness> <invite-url>` | submit a `hermes_gateway` join request for one harness |
| `bin/claim-api-key.sh <harness>` | claim and verify the API key after board approval |
| `workspace/` | cwd for every run; `repos/` is where agents clone things |

Secrets live outside the repo in `~/.paperclip/agents/<harness>/` (0600): `gateway-key`
(the bearer Paperclip sends), `join-*.json`, `claim-response.json`, `credentials.json`.
Run logs are in `~/.paperclip/runs/`.

## Setup

```sh
bin/install-skill.sh "$(curl -s https://<paperclip>/api/health | jq -r .commit)"
bin/install-service.sh                      # tailnet-only by default
sudo ufw allow in on tailscale0 to any port 8787 proto tcp   # if ufw is on

bin/join.sh claude https://<paperclip>/api/invites/<token>/onboarding.txt
# … board approves in Paperclip …
bin/claim-api-key.sh claude                 # picked up without a restart
```

`join.sh` registers `hermes_gateway` with `sessionKeyStrategy: issue`,
`timeoutSec: 3600` (the adapter default is 600) and
`dangerouslyAllowInsecureRemoteHttp: true`. The adapter refuses plain HTTP to
non-loopback hosts otherwise; over Tailscale the link is already WireGuard-encrypted.
For TLS instead, front it with `tailscale serve` and set `BRIDGE_PUBLIC_URL`.
The Paperclip host must be able to route to the gateway address.

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
| `BRIDGE_EXTRA_DIRS` | `~/projects` | `:`-separated extra dirs |
| `BRIDGE_MAX_CONCURRENCY` | `1` | per harness |
| `BRIDGE_RUN_TIMEOUT_MS` | `3600000` | the gateway's own hard limit |
| `BRIDGE_<HARNESS>_MODEL` | — | e.g. `BRIDGE_PI_MODEL=opencode-go/kimi-k3` |
| `CLAUDE_BIN` / `PI_BIN` / `CODEX_BIN` | on `PATH` | |
| `PAPERCLIP_HOME` | `~/.paperclip` | |

## Adding a harness

Drop `bridge/runners/<name>.mjs` exporting `{ name, bin, needsSkillPointer, args(opts), parse(event, out) }`
and register it in `RUNNERS` in `bridge.mjs`. `args` gets `{prompt, resumeId, sessionKey, workspace, extraDirs, model}`.
`parse` receives each JSONL stdout line and calls `out.delta(text)`, `out.session(id)`, `out.model(m)`,
`out.addUsage({...})`, `out.lastText(t)` and `out.result({isError, output, usage, costUsd})`.

Status: claude and pi have been tested end to end against the protocol (create, replay, SSE, resume, stop, restart).
The codex runner follows `codex exec --json` but hasn't been run here yet.
