#!/usr/bin/env bash
# Usage: bin/install-skill.sh [paperclip-git-ref]
# Installs Paperclip's `paperclip` skill (SKILL.md + references/ + scripts/) into
# workspace/.claude/skills/paperclip from github.com/paperclipai/paperclip.
# Pass your server's commit (GET <paperclip>/api/health -> .commit) to match it.
# Helper scripts missing at that ref are taken from master.

set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
ref="${1:-master}"
dest="$root/workspace/.claude/skills/paperclip"
repo="paperclipai/paperclip"

fetch() { gh api -H 'Accept: application/vnd.github.raw' "repos/$repo/contents/$1?ref=$2"; }

files="$(gh api "repos/$repo/git/trees/$ref?recursive=1" \
  --jq '.tree[] | select(.type == "blob" and (.path | startswith("skills/paperclip/"))) | .path')"
rm -rf "$dest"
mkdir -p "$dest"
for f in $files; do
  rel="${f#skills/paperclip/}"
  mkdir -p "$dest/$(dirname "$rel")"
  fetch "$f" "$ref" > "$dest/$rel"
done
# SKILL.md references this helper; older refs don't ship it.
if [[ ! -f "$dest/scripts/paperclip-issue-update.sh" ]]; then
  mkdir -p "$dest/scripts"
  fetch skills/paperclip/scripts/paperclip-issue-update.sh master > "$dest/scripts/paperclip-issue-update.sh"
fi
chmod +x "$dest"/scripts/*.sh 2>/dev/null || true
echo "Installed paperclip skill ($ref) to $dest"
