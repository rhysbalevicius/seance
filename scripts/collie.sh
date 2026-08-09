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

as_dev() { sudo -u "$DEV_USER" -H bash -lc "$1"; }

echo "[collie] bun (collie's runtime)"
as_dev 'command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash'
# Put bun on the system PATH so herdr's (minimal-env) service context finds it.
[[ -x "$DEV_HOME/.bun/bin/bun" ]] && ln -sf "$DEV_HOME/.bun/bin/bun" /usr/local/bin/bun

# Let dev's systemd --user services (the collie bridge) run with no login session
# and survive reboots.
loginctl enable-linger "$DEV_USER" 2>/dev/null || true

echo "[collie] plugin install"
as_dev 'herdr plugin install AltanS/collie 2>/dev/null || herdr plugin update herdr.collie || true'

# collie reads .env from its plugin config dir. It sits behind nginx, which
# forwards Host: collie.$VANITY_DOMAIN, so that origin has to be declared or
# collie rejects the request (same-origin / DNS-rebinding protection).
cfg_dir="$(as_dev 'herdr plugin config-dir herdr.collie' 2>/dev/null | tr -d '\r' | tail -n1)"
if [[ -n "$cfg_dir" ]]; then
  install -d -o "$DEV_USER" -g "$DEV_USER" "$cfg_dir"
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
COLLIE_PORT=$PORT
COLLIE_PUBLIC_HOSTS=$HOSTN
COLLIE_ALLOWED_ORIGINS=https://$HOSTN
# No COLLIE_TRUSTED_USER: behind nginx that gate can't work (it needs tailscale
# serve to inject the identity header). Collie is open to the tailnet here.
EOF
  install -m 0600 -o "$DEV_USER" -g "$DEV_USER" "$tmp" "$cfg_dir/.env"
  rm -f "$tmp"
else
  echo "[collie] WARNING: couldn't resolve the plugin config dir -- is herdr set up?"
  echo "         run 'herdr' once as $DEV_USER, then re-run: sudo seance-collie"
fi

echo "[collie] start bridge on 127.0.0.1:$PORT"
as_dev 'herdr plugin action invoke start --plugin herdr.collie' || \
  echo "[collie] WARNING: start failed; run 'herdr' once as $DEV_USER, then: sudo seance-collie"

/usr/local/bin/seance-expose add collie "$PORT" >/dev/null
echo "[collie] https://$HOSTN/  (tailnet-only; with a deSEC token the cert is publicly trusted, else trust the box CA on the phone first: sudo seance-ca root)"
