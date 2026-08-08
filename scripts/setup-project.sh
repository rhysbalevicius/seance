#!/usr/bin/env bash
# Bootstrap agent session: hand a freshly cloned project to a headless Claude
# Code run that figures out and performs environment setup, then writes
# AGENT_SETUP.md so every later session (and you) knows how to run things.
#
# Environments differ too much to automate declaratively -- so the automation
# IS an agent session, and all we supply is the repo + an optional hint (the
# setup_hint field on the project entry in tfvars, or extra args here).
#
# Spends real tokens; invoked manually, never automatically.
#
# Usage: seance-setup-project [--agent claude|codex|cursor|gemini] <project-dir> [extra hint...]
set -euo pipefail

agent=claude
if [[ "${1:-}" == "--agent" ]]; then agent="$2"; shift 2; fi
dir="${1:?usage: seance-setup-project [--agent <name>] <project-dir> [extra hint...]}"
shift || true
dir="$(cd "$dir" && pwd)"
extra_hint="${*:-}"

# Pull the setup_hint recorded for this project, if any
hint=""
projects="$(cat /etc/seance/projects.json 2>/dev/null || true)"
if [[ -n "$projects" ]]; then
  hint="$(echo "$projects" | jq -r --arg d "$(basename "$dir")" \
    '[.[] | select(.dir | endswith($d)) | .setup_hint // empty] | first // empty')"
fi

prompt="$(cat /etc/seance/setup-project.prompt.md)"
[[ -n "$hint" ]] && prompt+=$'\n\nOwner-supplied hint for this project:\n'"$hint"
[[ -n "$extra_hint" ]] && prompt+=$'\n\nAdditional hint from the invoker:\n'"$extra_hint"

cd "$dir"
echo "=== setup agent ($agent) on $dir ==="
# This box is a sandbox with no personal data; the session runs unattended
# with approvals/sandboxing off. Headless flags drift with vendor releases;
# this case statement is the place to fix one.
case "$agent" in
  claude) claude -p "$prompt" --dangerously-skip-permissions --verbose ;;
  codex)  codex exec --full-auto "$prompt" ;;
  gemini) gemini --yolo -p "$prompt" ;;
  cursor) cursor-agent -p "$prompt" ;;
  *) echo "unknown agent '$agent'" >&2; exit 1 ;;
esac
echo "=== done; see $dir/AGENT_SETUP.md ==="
