#!/usr/bin/env bash
# collie: a phone PWA for driving herdr herds (https://github.com/AltanS/collie).
# Installs it as a herdr plugin and exposes it at collie.$VANITY_DOMAIN through
# the box's nginx. Re-runnable.
#
# Access, plainly: behind nginx collie has NO person-level auth. Its gate
# (COLLIE_TRUSTED_USER) relies on `tailscale serve` injecting Tailscale-User-Login,
# which nginx does not do -- so anyone who can reach collie.$VANITY_DOMAIN (i.e.
# anyone on your tailnet) can read every pane and run commands as dev. Fine on a
# solo tailnet; on a shared one, serve collie via `tailscale serve` instead so it
# enforces your tailnet identity.
#
# Usage: sudo seance-collie
set -euo pipefail
source /etc/seance/seance.env 2>/dev/null || true

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
: "${VANITY_DOMAIN:?VANITY_DOMAIN not set; collie is served at collie.<vanity_domain>}"

DEV_USER="${SEANCE_USER:-dev}"
DEV_HOME="$(getent passwd "$DEV_USER" | cut -d: -f6)"
PORT=8787
HOSTN="collie.$VANITY_DOMAIN"
SECRETS=/etc/seance/secrets

as_dev() { sudo -u "$DEV_USER" -H bash -lc "$1"; }

echo "[collie] bun (collie's runtime)"
as_dev 'command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash'
# Put bun on the system PATH so herdr's (minimal-env) service context finds it.
[[ -x "$DEV_HOME/.bun/bin/bun" ]] && ln -sf "$DEV_HOME/.bun/bin/bun" /usr/local/bin/bun

# Let dev's systemd --user services (the collie bridge) run with no login session
# and survive reboots.
loginctl enable-linger "$DEV_USER" 2>/dev/null || true

# --yes: `herdr plugin install` has an interactive [y/N] prompt; a
# non-interactive run without it defaults to No and silently aborts, so the
# start step below fails with plugin_not_found. Not muted, so a genuine build
# failure (collie builds its UI with bun at install time) actually surfaces.
if as_dev 'herdr plugin list 2>/dev/null | grep -q herdr.collie'; then
  echo "[collie] plugin already installed"
else
  echo "[collie] plugin install"
  as_dev 'herdr plugin install --yes AltanS/collie'
fi

# collie reads .env from its plugin config dir. It sits behind nginx, which
# forwards Host: collie.$VANITY_DOMAIN, so that origin has to be declared or
# collie rejects the request (same-origin / DNS-rebinding protection).
cfg_dir="$(as_dev 'herdr plugin config-dir herdr.collie' 2>/dev/null | tr -d '\r' | tail -n1)"
if [[ -n "$cfg_dir" ]]; then
  install -d -o "$DEV_USER" -g "$DEV_USER" "$cfg_dir"

  # Web push (optional): a VAPID keypair in the secrets (collie_vapid_public /
  # collie_vapid_private / collie_vapid_subject) turns on push so the phone PWA
  # gets agent-status notifications. The keys must be STABLE -- rotating them
  # drops every existing subscription -- which is why they live in the sanctum,
  # not generated here. Generate once: npx web-push generate-vapid-keys.
  vapid_pub="$(cat "$SECRETS/collie_vapid_public" 2>/dev/null || true)"
  vapid_priv="$(cat "$SECRETS/collie_vapid_private" 2>/dev/null || true)"
  vapid_subj="$(cat "$SECRETS/collie_vapid_subject" 2>/dev/null || true)"

  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
COLLIE_PORT=$PORT
COLLIE_PUBLIC_HOSTS=$HOSTN
COLLIE_ALLOWED_ORIGINS=https://$HOSTN
# No COLLIE_TRUSTED_USER: behind nginx that gate can't work (it needs tailscale
# serve to inject the identity header). Collie is open to the tailnet here.
EOF
  if [[ -n "$vapid_pub" && -n "$vapid_priv" ]]; then
    cat >> "$tmp" <<EOF
COLLIE_VAPID_PUBLIC=$vapid_pub
COLLIE_VAPID_PRIVATE=$vapid_priv
COLLIE_VAPID_SUBJECT=${vapid_subj:-mailto:admin@$VANITY_DOMAIN}
EOF
    echo "[collie] web push enabled (VAPID from secrets)"
  else
    echo "[collie] web push disabled (add collie_vapid_* to secrets to enable)"
  fi

  install -m 0600 -o "$DEV_USER" -g "$DEV_USER" "$tmp" "$cfg_dir/.env"
  rm -f "$tmp"
else
  echo "[collie] WARNING: couldn't resolve the plugin config dir -- is herdr set up?"
  echo "         run 'herdr' once as $DEV_USER, then re-run: sudo seance-collie"
fi

# restart, not start: on a re-run this reloads the .env (e.g. newly added VAPID
# keys). Falls back to start when the bridge isn't running yet.
echo "[collie] (re)start bridge on 127.0.0.1:$PORT"
as_dev 'herdr plugin action invoke restart --plugin herdr.collie' 2>/dev/null \
  || as_dev 'herdr plugin action invoke start --plugin herdr.collie' \
  || echo "[collie] WARNING: start failed; run 'herdr' once as $DEV_USER, then: sudo seance-collie"

/usr/local/bin/seance-expose add collie "$PORT" >/dev/null
echo "[collie] https://$HOSTN/  (tailnet-only; with a deSEC token the cert is publicly trusted, else trust the box CA on the phone first: sudo seance-ca root)"
