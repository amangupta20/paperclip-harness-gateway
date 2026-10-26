#!/usr/bin/env bash
# Usage: bin/session-env.sh [harness]     (Claude Code SessionStart hook)
# Makes an interactive Claude Code session in the gateway workspace act as that
# harness's Paperclip agent: exports PAPERCLIP_* into the session's Bash env via
# $CLAUDE_ENV_FILE and prints who it is (stdout becomes session context).
# Gateway runs already carry PAPERCLIP_API_KEY, so it does nothing for them.

set -euo pipefail
[[ -n "${PAPERCLIP_API_KEY:-}" ]] && exit 0
source "$(dirname "$0")/_env.sh"
harness="${1:-claude}"
creds="$PAPERCLIP_HOME/agents/$harness/credentials.json"
if [[ ! -f "$creds" ]]; then
  echo "Paperclip: no claimed credentials for the $harness agent ($creds); Paperclip API calls will not work in this session."
  exit 0
fi

if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  jq -r '{PAPERCLIP_API_URL: .apiUrl, PAPERCLIP_API_KEY: .apiKey, PAPERCLIP_AGENT_ID: .agentId, PAPERCLIP_COMPANY_ID: .companyId}
    | to_entries[] | "export \(.key)=\(.value | @sh)"' "$creds" >> "$CLAUDE_ENV_FILE"
fi

jq -r '"This is an interactive session started by the operator in the Paperclip agent workspace. You act as the Paperclip agent \"\(.agentName // "unknown")\" (agent \(.agentId), company \(.companyId)) on \(.apiUrl).",
  "- PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_AGENT_ID and PAPERCLIP_COMPANY_ID are exported in Bash. Never print the API key.",
  "- Use the `paperclip` skill for the API, but this is not a heartbeat: only touch Paperclip when the operator asks, and confirm before changing issues they did not mention.",
  "- There is no PAPERCLIP_RUN_ID, so omit the X-Paperclip-Run-Id header and call the API with curl; the skill'\''s helper scripts require a run id and will refuse."' "$creds"
