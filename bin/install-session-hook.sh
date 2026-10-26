#!/usr/bin/env bash
# Usage: bin/install-session-hook.sh [harness]
# Adds bin/session-env.sh as a SessionStart hook in <workspace>/.claude/settings.json,
# so `claude` started in the workspace knows and can act as the harness's agent.
# Project hooks don't apply to sessions started in subfolders (their own repos).

set -euo pipefail
source "$(dirname "$0")/_env.sh"
harness="${1:-claude}"
settings="$workspace/.claude/settings.json"
cmd="$root/bin/session-env.sh $harness"

mkdir -p "$(dirname "$settings")"
[[ -f "$settings" ]] || echo '{}' > "$settings"
tmp="$(mktemp)"
jq --arg cmd "$cmd" '
  .hooks.SessionStart = ([(.hooks.SessionStart // [])[] | .hooks |= map(select(.command | test("/session-env\\.sh") | not)) | select(.hooks | length > 0)]
    + [{hooks: [{type: "command", command: $cmd}]}])' "$settings" > "$tmp"
mv "$tmp" "$settings"
echo "Installed SessionStart hook in $settings ($cmd)"
