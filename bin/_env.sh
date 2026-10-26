# Sourced by bin/*.sh: repo root, PAPERCLIP_HOME, and the gateway's env file
# (the same file the systemd unit loads), so scripts agree on the workspace.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
if [[ -f "$PAPERCLIP_HOME/gateway.env" ]]; then
  set -a; source "$PAPERCLIP_HOME/gateway.env"; set +a
fi
workspace="${BRIDGE_WORKSPACE:-$root/workspace}"
