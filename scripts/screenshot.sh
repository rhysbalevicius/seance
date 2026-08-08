#!/usr/bin/env bash
# Screenshot a URL with headless Chromium (Playwright). This is how the agent
# "sees" frontend work running on the box -- point it at localhost, no need
# to expose the app first.
#
# Usage: seance-screenshot <url> [outfile.png] [--full]
#   seance-screenshot http://localhost:3000
#   seance-screenshot http://localhost:3000 dash.png --full
set -euo pipefail

url="${1:?usage: seance-screenshot <url> [outfile.png] [--full]}"
out="${2:-/tmp/screenshot-$(date +%s).png}"
extra=()
[[ "${3:-}" == "--full" || "${2:-}" == "--full" ]] && extra+=(--full-page)
[[ "${2:-}" == "--full" ]] && out="/tmp/screenshot-$(date +%s).png"

playwright screenshot \
  --browser chromium \
  --viewport-size "1440,900" \
  --wait-for-timeout 3000 \
  "${extra[@]}" \
  "$url" "$out" >/dev/null

echo "$out"
