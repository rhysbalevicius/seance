#!/usr/bin/env bash
# Push a file or directory to the sanctum account's artifacts bucket.
# Usage: seance-push-artifact <path> [key-prefix]
#   seance-push-artifact results/run-42            -> s3://$BUCKET/seance/<host>/<date>/run-42/...
#   seance-push-artifact summary.json reports/aug  -> s3://$BUCKET/reports/aug/summary.json
set -euo pipefail
source /etc/seance/seance.env

src="${1:?usage: seance-push-artifact <path> [key-prefix]}"
prefix="${2:-seance/$(hostname -s)/$(date -u +%F)/$(basename "$src")}"
dest="s3://$SANCTUM_BUCKET/$prefix"

if [[ -d "$src" ]]; then
  aws --profile sanctum s3 cp --recursive "$src" "$dest"
else
  aws --profile sanctum s3 cp "$src" "$dest"
fi
echo "pushed -> $dest"
