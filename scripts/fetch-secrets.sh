#!/usr/bin/env bash
# Copy /etc/seance/secrets/env (root-only, written by `seance-secrets pull`
# from the sanctum account) into ~/.config/seance/env for the dev user's
# shells. Re-run after every pull.
# Usage: seance-fetch-secrets
set -euo pipefail

out="$HOME/.config/seance/env"
mkdir -p "$(dirname "$out")"

sudo cat /etc/seance/secrets/env > "$out.tmp"
chmod 600 "$out.tmp"
mv "$out.tmp" "$out"
echo "wrote $out ($(grep -c '=' "$out" || true) entries). New shells pick it up; current shell: set -a; . $out; set +a"
