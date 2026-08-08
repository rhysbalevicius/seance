#!/usr/bin/env bash
# Install and inspect the coding-agent CLIs. Which ones a box gets is the
# `agents` list in tfvars (-> AGENTS in /etc/seance/seance.env); add more
# later with `sudo seance-agents install <name>`.
#
# Install commands drift as vendors move fast -- this file is the single
# place to fix one when it does.
#
# Usage:
#   sudo seance-agents install [name...]   # default: $AGENTS from seance.env
#   seance-agents status                   # installed? authenticated?
#   seance-agents list                     # names this script knows
set -euo pipefail
source /etc/seance/seance.env 2>/dev/null || true

DEV_USER=dev
DEV_HOME=/home/$DEV_USER
KNOWN="claude codex cursor gemini"

install_one() {
  case "$1" in
    claude) # Claude Code (Anthropic)
      npm install -g @anthropic-ai/claude-code >/dev/null ;;
    codex)  # Codex CLI (OpenAI)
      npm install -g @openai/codex >/dev/null ;;
    gemini) # Gemini CLI (Google)
      npm install -g @google/gemini-cli >/dev/null ;;
    cursor) # Cursor CLI -- vendor script, installs to ~/.local/bin as the dev user
      sudo -u "$DEV_USER" bash -c 'mkdir -p ~/.local/bin && curl -fsS https://cursor.com/install | bash' ;;
    *) echo "unknown agent '$1' (known: $KNOWN)" >&2; return 1 ;;
  esac
  echo "[agents] installed: $1"
}

ENV_FILE="$DEV_HOME/.config/seance/env"
env_set() { # env_set <VAR> -- true when VAR is present and non-empty
  [[ -f "$ENV_FILE" ]] || return 1
  ( set -a; . "$ENV_FILE" >/dev/null 2>&1; [[ -n "${!1:-}" ]] )
}

auth_state() { # best-effort: where each CLI drops its credentials
  case "$1" in
    claude)
      if [[ -f "$DEV_HOME/.claude/.credentials.json" ]]; then echo "logged in (~/.claude)"
      elif env_set CLAUDE_CODE_OAUTH_TOKEN; then echo "token via env (subscription)"
      else echo "NOT authenticated -- see README 'Agent auth'"; fi ;;
    codex)
      [[ -f "$DEV_HOME/.codex/auth.json" ]] && echo "logged in (~/.codex/auth.json)" \
        || echo "NOT authenticated -- see README 'Agent auth'" ;;
    gemini)
      if ls "$DEV_HOME"/.gemini/oauth_creds*.json >/dev/null 2>&1; then echo "logged in (~/.gemini)"
      elif env_set GEMINI_API_KEY; then echo "api key via env"
      else echo "NOT authenticated -- see README 'Agent auth'"; fi ;;
    cursor)
      if env_set CURSOR_API_KEY; then echo "api key via env"
      elif [[ -d "$DEV_HOME/.config/cursor" || -d "$DEV_HOME/.cursor" ]]; then echo "config present (verify: cursor-agent status)"
      else echo "NOT authenticated -- see README 'Agent auth'"; fi ;;
  esac
}

binary_for() {
  case "$1" in
    claude) echo claude ;;
    codex)  echo codex ;;
    gemini) echo gemini ;;
    cursor) echo cursor-agent ;;
  esac
}

cmd="${1:-status}"
case "$cmd" in
  install)
    [[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
    shift || true
    targets="${*:-${AGENTS:-claude}}"
    for a in $targets; do install_one "$a"; done
    ;;
  status)
    for a in $KNOWN; do
      bin="$(binary_for "$a")"
      if sudo -u "$DEV_USER" bash -lc "command -v $bin" >/dev/null 2>&1; then
        printf "%-8s installed   %s\n" "$a" "$(auth_state "$a")"
      else
        printf "%-8s -\n" "$a"
      fi
    done
    ;;
  list) echo "$KNOWN" ;;
  *) echo "usage: seance-agents {install [name...] | status | list}" >&2; exit 1 ;;
esac
