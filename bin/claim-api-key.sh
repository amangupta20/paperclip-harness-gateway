#!/usr/bin/env bash
# Usage: bin/claim-api-key.sh <harness>
# One-time Paperclip API key claim after board approval. Writes the raw claim
# response and a derived credentials.json to ~/.paperclip/agents/<harness>/ (0600),
# then verifies the key with GET /api/agents/me. Never prints the token.

set -euo pipefail
umask 077

harness="${1:?usage: $0 <harness>}"
dir="${PAPERCLIP_HOME:-$HOME/.paperclip}/agents/$harness"
join="$dir/join-response.json"
raw="$dir/claim-response.json"
creds="$dir/credentials.json"
API_URL="${PAPERCLIP_API_URL:-$(jq -r '.agentDefaultsPayload.paperclipApiUrl // empty' "$dir/join-request.json")}"
[[ -n "$API_URL" ]] || { echo "Set PAPERCLIP_API_URL (no paperclipApiUrl in $dir/join-request.json)." >&2; exit 1; }

if [[ -s "$raw" ]] && jq -e '.token' "$raw" >/dev/null 2>&1; then
  echo "Already claimed ($raw); skipping the claim and re-verifying." >&2
else
  request_id="$(jq -r '.id' "$join")"
  code="$(jq -n --arg s "$(jq -r '.claimSecret' "$join")" '{claimSecret: $s}' |
    curl -sS -m 30 -X POST -H 'Content-Type: application/json' --data-binary @- \
      -o "$raw.tmp" -w '%{http_code}' "$API_URL/api/join-requests/$request_id/claim-api-key")"
  if [[ "$code" != 2* ]] || ! jq -e '.token | type == "string" and (contains("...") | not) and (contains("[redacted]") | not)' "$raw.tmp" >/dev/null 2>&1; then
    echo "Claim failed (HTTP $code). Not approved yet? Response:" >&2
    jq 'walk(if type == "object" then with_entries(if (.key | test("token|secret"; "i")) then .value = "<hidden>" else . end) else . end)' "$raw.tmp" >&2 || cat "$raw.tmp" >&2
    rm -f "$raw.tmp"
    exit 1
  fi
  mv "$raw.tmp" "$raw"
fi

token="$(jq -r '.token' "$raw")"
me="$(curl -sS -m 30 -H "Authorization: Bearer $token" -w '\n%{http_code}' "$API_URL/api/agents/me")"
me_code="${me##*$'\n'}"
me_body="${me%$'\n'*}"
if [[ "$me_code" != 200 ]]; then
  echo "Key verification failed: GET /api/agents/me returned HTTP $me_code" >&2
  exit 1
fi

jq -n --arg apiUrl "$API_URL" --arg apiKey "$token" --argjson me "$me_body" \
  '{apiUrl: $apiUrl, apiKey: $apiKey, agentId: $me.id, companyId: $me.companyId, agentName: $me.name}' > "$creds"
echo "Verified. Agent: $(jq -r '"\(.name) (\(.id)), adapter \(.adapterType // "?"), status \(.status // "?")"' <<<"$me_body")"
echo "Credentials written to $creds (the bridge picks them up on the next run)"
