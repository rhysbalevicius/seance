#!/usr/bin/env bash
# TLS for the box's vanity domain, in one of two modes:
#
#   public  -- a deSEC API token is present (secrets: desec_token): issue a real
#              Let's Encrypt WILDCARD cert for $VANITY_DOMAIN + *.$VANITY_DOMAIN
#              over the DNS-01 challenge (certbot + certbot-dns-desec). DNS-01
#              proves control by writing a TXT record through deSEC's API, so it
#              needs no inbound port -- which is why it works for a zero-ingress
#              box on a Tailscale address. Publicly trusted and auto-renewing:
#              nothing to install on your laptop or phone.
#
#   private -- no token: a self-signed CA + wildcard leaf via seance-ca, trusted
#              once per device. The fallback, so the repo works with no external
#              DNS account.
#
# nginx serves /etc/seance/tls/{fullchain,privkey}.pem in both modes, so
# expose.sh, collie and the catch-all vhost never care which one is active.
#
# Usage:
#   sudo seance-cert ensure    # issue/renew as appropriate (idempotent)
#   seance-cert status
set -euo pipefail
source /etc/seance/seance.env
: "${VANITY_DOMAIN:?VANITY_DOMAIN not set}"

TLS_DIR=/etc/seance/tls
SECRETS=/etc/seance/secrets
TOKEN_FILE="$SECRETS/desec_token"
CREDS_DIR=/etc/letsencrypt/secrets
CREDS="$CREDS_DIR/desec.ini"
LE_LIVE="/etc/letsencrypt/live/$VANITY_DOMAIN"
HOOK=/etc/letsencrypt/renewal-hooks/deploy/seance-tls.sh
CERT_EMAIL="${CERT_EMAIL:-}"   # optional (from seance.env); else register w/o email

have_token() { [[ -s "$TOKEN_FILE" ]]; }

# Private-CA fallback. seance-ca is on PATH after the bootstrap helper loop; at
# first boot it is not yet, so fall back to the sibling script via bash (no
# dependence on its exec bit).
run_ca() {
  if command -v seance-ca >/dev/null 2>&1; then
    seance-ca ensure
  elif [[ -f "$(dirname "$0")/ca.sh" ]]; then
    bash "$(dirname "$0")/ca.sh" ensure
  else
    echo "[cert] no private-CA fallback found" >&2
    return 1
  fi
}

install_certbot() {
  if command -v certbot >/dev/null 2>&1 && python3 -c 'import certbot_dns_desec' 2>/dev/null; then
    return 0
  fi
  echo "[cert] installing certbot + certbot-dns-desec"
  # pip, not apt: the apt certbot-dns-* plugins don't include desec, and an apt
  # certbot next to a pip plugin can end up importing two different certbots.
  pip3 install --break-system-packages -q certbot certbot-dns-desec
}

# certbot runs every executable in renewal-hooks/deploy/ after a successful
# issuance or renewal. This one repoints nginx's stable paths at the current
# Let's Encrypt material and reloads -- so auto-renewals need no other wiring.
write_hook() {
  install -d -m 0755 "$(dirname "$HOOK")"
  cat > "$HOOK" <<EOF
#!/usr/bin/env bash
set -e
install -d -m 0755 "$TLS_DIR"
ln -sf "$LE_LIVE/fullchain.pem" "$TLS_DIR/fullchain.pem"
ln -sf "$LE_LIVE/privkey.pem"  "$TLS_DIR/privkey.pem"
systemctl reload nginx 2>/dev/null || true
EOF
  chmod 0755 "$HOOK"
}

# pip's certbot ships no renewal timer (the Debian package does). Install ours.
setup_renew_timer() {
  local certbot_bin
  certbot_bin="$(command -v certbot)"
  cat > /etc/systemd/system/seance-cert-renew.service <<EOF
[Unit]
Description=seance: renew TLS certificates
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$certbot_bin renew --quiet
EOF
  cat > /etc/systemd/system/seance-cert-renew.timer <<'EOF'
[Unit]
Description=seance: twice-daily TLS renewal

[Timer]
OnCalendar=*-*-* 03,15:00:00
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now seance-cert-renew.timer >/dev/null 2>&1 || true
}

issue_le() {
  install_certbot || return 1
  install -d -m 0700 "$CREDS_DIR"
  ( umask 077; printf 'dns_desec_token = %s\n' "$(cat "$TOKEN_FILE")" > "$CREDS" )
  chmod 0600 "$CREDS"
  write_hook

  local reg=(--register-unsafely-without-email)
  [[ -n "$CERT_EMAIL" ]] && reg=(-m "$CERT_EMAIL")

  if certbot certonly --non-interactive --agree-tos "${reg[@]}" \
       --authenticator dns-desec --dns-desec-credentials "$CREDS" \
       --dns-desec-propagation-seconds 120 \
       --keep-until-expiring --expand \
       -d "$VANITY_DOMAIN" -d "*.$VANITY_DOMAIN"; then
    bash "$HOOK" || true          # link the paths even when certbot no-ops
    setup_renew_timer
    return 0
  fi
  return 1
}

ensure() {
  [[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
  install -d -m 0755 "$TLS_DIR"
  if have_token; then
    if issue_le; then
      echo "[cert] Let's Encrypt wildcard active for $VANITY_DOMAIN (auto-renewing)"
    else
      echo "[cert] WARNING: Let's Encrypt issuance failed -- is the deSEC delegation live and the token valid?" >&2
      echo "[cert] falling back to the private CA so nginx still has a cert; re-run 'sudo seance-cert ensure' once DNS is ready" >&2
      run_ca
    fi
  else
    run_ca
  fi
}

status() {
  echo "domain: $VANITY_DOMAIN"
  if have_token; then echo "mode:   Let's Encrypt (deSEC DNS-01)"; else echo "mode:   private CA (no deSEC token)"; fi
  if [[ -e "$TLS_DIR/fullchain.pem" ]]; then
    local issuer enddate
    issuer="$(openssl x509 -in "$TLS_DIR/fullchain.pem" -noout -issuer 2>/dev/null | sed 's/^issuer=//')"
    enddate="$(openssl x509 -in "$TLS_DIR/fullchain.pem" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
    echo "issuer: ${issuer:-<unreadable; run with sudo>}"
    echo "expiry: ${enddate:-<unreadable; run with sudo>}"
  else
    echo "cert:   none yet -- run: sudo seance-cert ensure"
  fi
  if have_token; then
    if systemctl is-active --quiet seance-cert-renew.timer 2>/dev/null; then
      echo "renew:  seance-cert-renew.timer active"
    else
      echo "renew:  timer not active (run: sudo seance-cert ensure)"
    fi
  fi
}

case "${1:-status}" in
  ensure) ensure ;;
  status) status ;;
  *) echo "usage: seance-cert {ensure|status}" >&2; exit 1 ;;
esac
