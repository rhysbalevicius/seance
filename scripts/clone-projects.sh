#!/usr/bin/env bash
# Clone the project set from /etc/seance/projects.json (the projects list in
# your tfvars). Repo URLs are not secret, so this file is world-readable; the
# deploy keys it relies on come from the sanctum account.
# Idempotent: existing clones are left untouched (they may hold uncommitted
# agent work).
#
# "profile" selects the git identity dir (/srv/projects/<profile>/<dir>) and,
# via the gh-<profile> SSH alias, the deploy key.
set -euo pipefail

projects="$(cat /etc/seance/projects.json)"

echo "$projects" | jq -c '.[]' | while read -r p; do
  profile=$(echo "$p" | jq -r .profile)
  url=$(echo "$p" | jq -r .url)
  dir=$(echo "$p" | jq -r .dir)
  ref=$(echo "$p" | jq -r '.ref // empty')
  dest="/srv/projects/$profile/$dir"
  if [[ -d "$dest/.git" ]]; then
    echo "exists: $dest (skipped)"
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  if [[ -n "$ref" ]]; then
    git clone --branch "$ref" "$url" "$dest"
  else
    git clone "$url" "$dest"
  fi
  echo "cloned: $dest"
done
