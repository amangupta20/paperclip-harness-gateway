#!/usr/bin/env bash
# Usage: bin/join.sh <harness> <invite-onboarding-url> [agent name] [capabilities]
# Submits a hermes_gateway join request pointing Paperclip at this bridge's
# /<harness> prefix. Saves the request and response (with the one-time claim
# secret) to ~/.paperclip/agents/<harness>/ (0600). After board approval, run
# bin/claim-api-key.sh <harness>.

set -euo pipefail
umask 077

harness="${1:?usage: $0 <harness> <invite-onboarding-url> [name] [capabilities]}"
invite_url="${2:?invite onboarding url required (…/api/invites/<token>/onboarding.txt)}"
host="$(hostname)"
name="${3:-$harness ($host)}"
caps="${4:-Coding agent ($harness CLI) on $host via paperclip-harness-gateway: code reading/writing, debugging, refactoring, review, tests, shell/git operations, docs.}"

base="${invite_url%%/api/invites/*}"
token="$(sed -E 's|.*/api/invites/([^/]+).*|\1|' <<<"$invite_url")"
# The URL Paperclip uses to reach this gateway; defaults to this machine's Tailscale IP.
bridge_url="${BRIDGE_PUBLIC_URL:-http://$(tailscale ip -4 | head -1):${BRIDGE_PORT:-8787}}"
dir="${PAPERCLIP_HOME:-$HOME/.paperclip}/agents/$harness"
mkdir -p "$dir"
[[ -s "$dir/gateway-key" ]] || openssl rand -hex 32 > "$dir/gateway-key"
if [[ -s "$dir/join-response.json" ]]; then
  echo "$dir/join-response.json already exists; refusing to submit a second join request." >&2
  exit 1
fi

jq -n --arg name "$name" --arg caps "$caps" --arg url "$bridge_url/$harness" \
  --arg key "$(cat "$dir/gateway-key")" --arg pc "$base" '{
  requestType: "agent",
  agentName: $name,
  adapterType: "hermes_gateway",
  capabilities: $caps,
  agentDefaultsPayload: {
    apiBaseUrl: $url,
    apiKey: $key,
    paperclipApiUrl: $pc,
    sessionKeyStrategy: "issue",
    timeoutSec: 3600,
    dangerouslyAllowInsecureRemoteHttp: true
  }
}' > "$dir/join-request.json"

code="$(curl -sS -m 30 -X POST -H 'Content-Type: application/json' --data-binary @"$dir/join-request.json" \
  -o "$dir/join-response.json" -w '%{http_code}' "$base/api/invites/$token/accept")"
if [[ "$code" != 2* ]]; then
  echo "Join failed (HTTP $code):" >&2
  jq 'del(.claimSecret)' "$dir/join-response.json" >&2 || cat "$dir/join-response.json" >&2
  mv "$dir/join-response.json" "$dir/join-response.failed.json"
  exit 1
fi
jq -r '"Join request \(.id) for \(.agentName): \(.status)"' "$dir/join-response.json"
