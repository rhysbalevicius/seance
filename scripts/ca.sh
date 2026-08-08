#!/usr/bin/env bash
# Private CA for the box's vanity domain. Generates a root CA (10 years) and
# a wildcard leaf for $VANITY_DOMAIN + *.$VANITY_DOMAIN (730 days -- Apple
# platforms reject TLS server certs over 825 days regardless of trust root).
# nginx serves the leaf; you trust the root once per device.
#
# Usage:
#   sudo seance-ca ensure    # create CA/leaf if missing or leaf <30d from expiry
#   seance-ca root           # print the root cert PEM (pipe to a file, trust it)
#   seance-ca status         # expiry dates + the DNS records to set at the registrar
set -euo pipefail
source /etc/seance/seance.env
: "${VANITY_DOMAIN:?VANITY_DOMAIN not set}"

CA_DIR=/etc/seance/ca
TLS_DIR=/etc/seance/tls

cmd="${1:-status}"

ensure() {
  [[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
  install -d -m 0700 "$CA_DIR"
  install -d -m 0755 "$TLS_DIR"

  if [[ ! -f "$CA_DIR/root.key" ]]; then
    echo "[ca] generating root CA (10y): seance $SEANCE_NAME"
    openssl ecparam -name prime256v1 -genkey -noout -out "$CA_DIR/root.key"
    openssl req -x509 -new -key "$CA_DIR/root.key" -sha256 -days 3650 \
      -subj "/O=seance/CN=seance $SEANCE_NAME root CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -out "$CA_DIR/root.crt"
    chmod 0600 "$CA_DIR/root.key"
  fi

  # (Re)issue the leaf when absent or within 30 days of expiry
  if [[ ! -f "$TLS_DIR/privkey.pem" ]] || \
     ! openssl x509 -in "$TLS_DIR/cert.pem" -checkend $((30*24*3600)) >/dev/null 2>&1; then
    echo "[ca] issuing wildcard leaf for $VANITY_DOMAIN (730d)"
    openssl ecparam -name prime256v1 -genkey -noout -out "$TLS_DIR/privkey.pem"
    openssl req -new -key "$TLS_DIR/privkey.pem" \
      -subj "/CN=*.$VANITY_DOMAIN" -out "$TLS_DIR/leaf.csr"
    openssl x509 -req -in "$TLS_DIR/leaf.csr" \
      -CA "$CA_DIR/root.crt" -CAkey "$CA_DIR/root.key" -CAcreateserial \
      -sha256 -days 730 \
      -extfile <(printf "subjectAltName=DNS:%s,DNS:*.%s\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n" "$VANITY_DOMAIN" "$VANITY_DOMAIN") \
      -out "$TLS_DIR/cert.pem"
    rm -f "$TLS_DIR/leaf.csr"
    cat "$TLS_DIR/cert.pem" "$CA_DIR/root.crt" > "$TLS_DIR/fullchain.pem"
    chmod 0600 "$TLS_DIR/privkey.pem"
    systemctl reload nginx 2>/dev/null || true
  fi
}

case "$cmd" in
  ensure) ensure ;;
  root)   cat "$CA_DIR/root.crt" ;;
  status)
    ts_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
    echo "domain: $VANITY_DOMAIN"
    [[ -f "$CA_DIR/root.crt" ]] && echo "root CA:  $(openssl x509 -in "$CA_DIR/root.crt" -noout -enddate)"
    [[ -f "$TLS_DIR/cert.pem" ]] && echo "leaf:     $(openssl x509 -in "$TLS_DIR/cert.pem" -noout -enddate)"
    echo
    echo "one-time DNS at the registrar (host records on the parent domain):"
    echo "  A  ${VANITY_DOMAIN%%.*}    ${ts_ip:-<tailscale ip>}"
    echo "  A  *.${VANITY_DOMAIN%%.*}  ${ts_ip:-<tailscale ip>}"
    echo
    echo "trust the root on each device:  ssh dev@$SEANCE_NAME seance-ca root > seance-root.crt"
    echo "  macOS: open Keychain Access, import, set 'Always Trust' (or:"
    echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain seance-root.crt)"
    echo "  iOS: AirDrop the file, install profile, then Settings -> General -> About -> Certificate Trust Settings"
    ;;
  *) echo "usage: seance-ca {ensure|root|status}" >&2; exit 1 ;;
esac
