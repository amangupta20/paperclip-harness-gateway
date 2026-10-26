#!/usr/bin/env bash
# Usage: bin/install-service.sh [bind-address]
# Installs and (re)starts the gateway as a systemd user service. The bind address
# defaults to this machine's Tailscale IPv4, so it is only reachable over the tailnet.

set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
bind="${1:-$(tailscale ip -4 2>/dev/null | head -1)}"
[[ -n "$bind" ]] || { echo "No bind address given and no Tailscale IPv4 found." >&2; exit 1; }

node="$(command -v node)"
path="$(dirname "$node")"
for bin in claude pi codex; do
  command -v "$bin" >/dev/null && path="$path:$(dirname "$(command -v "$bin")")"
done
path="$path:/usr/local/bin:/usr/bin:/bin"

unit="$HOME/.config/systemd/user/paperclip-bridge.service"
mkdir -p "$(dirname "$unit")"
sed -e "s|@NODE@|$node|" -e "s|@ROOT@|$root|" -e "s|@PATH@|$path|" -e "s|@BIND@|$bind|" \
  "$root/bridge/paperclip-bridge.service" > "$unit"
systemctl --user daemon-reload
systemctl --user enable paperclip-bridge.service
systemctl --user restart paperclip-bridge.service
echo "Installed $unit (bind $bind). Logs: journalctl --user -u paperclip-bridge -f"
