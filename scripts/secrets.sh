#!/usr/bin/env bash
# Pull the box's credentials from the sanctum account's secrets bucket.
#
# The files are sops-encrypted under a KMS key that only the sanctum role can
# use, so the box needs no passphrase: it decrypts with the same assumed role
# it uses for artifacts. That is what makes this work on a first boot, before
# anything else on the box exists -- and it is why a passphrase-based scheme
# could not, since the passphrase would have to arrive in user_data.
#
# secrets/shared.sops.yaml applies to every box. secrets/boxes/<name>.sops.yaml
# is an optional overlay merged over it: objects merge key by key, lists (like
# git_profiles) replace wholesale.
#
# Rotation is: `sops secrets/shared.sops.yaml` on your laptop, apply the sanctum
# stack, then `sudo seance-secrets pull` here. No rebuild, nothing to taint.
#
# Usage:
#   sudo seance-secrets pull     # refresh /etc/seance/secrets from the sanctum
#   seance-secrets status        # what is on disk (run with sudo for detail)
set -euo pipefail
source /etc/seance/seance.env

SECRETS=/etc/seance/secrets
STAMP=/etc/seance/secrets/.pulled

pull() {
  [[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
  : "${SECRETS_BUCKET:?SECRETS_BUCKET not set in /etc/seance/seance.env}"
  command -v sops >/dev/null || { echo "sops not installed; re-run bootstrap.sh" >&2; exit 1; }

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  # The profile is passed per-command rather than exported: seance-sanctum-creds
  # runs `aws sts assume-role` on the default chain, and an inherited
  # AWS_PROFILE=sanctum would send it back through itself.
  aws --profile sanctum s3 cp "s3://$SECRETS_BUCKET/secrets/shared.sops.yaml" "$tmp/shared.enc" --quiet
  AWS_PROFILE=sanctum sops -d --input-type yaml --output-type json "$tmp/shared.enc" > "$tmp/shared.json"

  if aws --profile sanctum s3 cp "s3://$SECRETS_BUCKET/secrets/boxes/$SEANCE_NAME.sops.yaml" "$tmp/box.enc" --quiet 2>/dev/null; then
    AWS_PROFILE=sanctum sops -d --input-type yaml --output-type json "$tmp/box.enc" > "$tmp/box.json"
    echo "[secrets] shared + $SEANCE_NAME overlay"
  else
    echo '{}' > "$tmp/box.json"
    echo "[secrets] shared (no overlay for $SEANCE_NAME)"
  fi

  jq -s '.[0] * .[1]' "$tmp/shared.json" "$tmp/box.json" > "$tmp/merged.json"

  jq -r '.tailscale_authkey      // empty' "$tmp/merged.json" > "$tmp/tailscale-authkey"
  jq -r '.desec_token            // empty' "$tmp/merged.json" > "$tmp/desec_token"
  jq -r '.collie_vapid_public    // empty' "$tmp/merged.json" > "$tmp/collie_vapid_public"
  jq -r '.collie_vapid_private   // empty' "$tmp/merged.json" > "$tmp/collie_vapid_private"
  jq -r '.collie_vapid_subject   // empty' "$tmp/merged.json" > "$tmp/collie_vapid_subject"
  jq -r '.nuke_passphrase_sha256 // empty' "$tmp/merged.json" > "$tmp/nuke.sha256"
  jq -c '.git_profiles           // []'    "$tmp/merged.json" > "$tmp/git-profiles.json"
  # @sh shell-quotes each value, so a key containing spaces, quotes or $(...)
  # is inert in the shell that sources this file.
  jq -r '(.env // {}) | to_entries[] | "\(.key)=\(.value | tostring | @sh)"' \
    "$tmp/merged.json" > "$tmp/env"

  install -d -m 0700 "$SECRETS"
  for f in tailscale-authkey desec_token collie_vapid_public collie_vapid_private collie_vapid_subject env git-profiles.json; do
    install -m 0600 "$tmp/$f" "$SECRETS/$f"
  done
  install -m 0600 "$tmp/nuke.sha256" /etc/seance/nuke.sha256
  date -u +%FT%TZ > "$STAMP"
  chmod 0600 "$STAMP"

  echo "[secrets] wrote $SECRETS/{tailscale-authkey,desec_token,env,git-profiles.json} + /etc/seance/nuke.sha256"
  echo "[secrets] refresh the dev shell env with: seance-fetch-secrets"
}

status() {
  echo "secrets bucket: ${SECRETS_BUCKET:-<unset>}"
  echo "box:            ${SEANCE_NAME:-<unset>}"
  if [[ -r "$STAMP" ]]; then
    echo "last pull:      $(cat "$STAMP")"
  elif [[ $EUID -ne 0 ]]; then
    echo "last pull:      unknown (root-only; re-run with sudo)"
  else
    echo "last pull:      never"
  fi
  for f in tailscale-authkey desec_token env git-profiles.json; do
    if [[ -s "$SECRETS/$f" ]]; then
      echo "  $f: present"
    elif [[ $EUID -ne 0 ]]; then
      echo "  $f: unknown (root-only)"
    else
      echo "  $f: MISSING"
    fi
  done
}

case "${1:-status}" in
  pull)   pull ;;
  status) status ;;
  *) echo "usage: seance-secrets {pull|status}" >&2; exit 1 ;;
esac
