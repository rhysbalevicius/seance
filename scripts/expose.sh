#!/usr/bin/env bash
# Expose a local web app to the tailnet over HTTPS.
#
# Vanity mode (VANITY_DOMAIN set): unlimited named apps --
#     seance-expose add webapp 3000   -> https://webapp.agent1.example.com/
# The wildcard DNS record and wildcard cert already cover every name, so this
# is just an nginx vhost write + reload: agents can mint preview hostnames on
# the fly. WebSocket upgrade headers included (Vite/Next HMR works).
#
# Fallback mode (no vanity domain): `tailscale serve` on the ts.net name;
# ports 443/8443/10000, so at most three apps at a time.
#
# Usage:
#   seance-expose add <name> <local-port>     (vanity)
#   seance-expose add <local-port> [443|8443|10000]   (fallback)
#   seance-expose ls | rm <name-or-port>
set -euo pipefail
source /etc/seance/seance.env 2>/dev/null || true

cmd="${1:-ls}"
NGINX_DIR=/etc/nginx/conf.d

fqdn_ts() { tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//'; }

vanity() { [[ -n "${VANITY_DOMAIN:-}" ]]; }

case "$cmd" in
  add)
    if vanity; then
      name="${2:?usage: seance-expose add <name> <local-port>}"
      local_port="${3:?usage: seance-expose add <name> <local-port>}"
      [[ "$name" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "invalid name '$name'" >&2; exit 1; }
      sudo tee "$NGINX_DIR/seance-$name.conf" >/dev/null <<EOF
server {
    listen 443 ssl;
    server_name $name.$VANITY_DOMAIN;
    ssl_certificate     /etc/seance/tls/fullchain.pem;
    ssl_certificate_key /etc/seance/tls/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:$local_port;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }
}
EOF
      sudo nginx -t -q && sudo systemctl reload nginx
      echo "https://$name.$VANITY_DOMAIN/"
    else
      local_port="${2:?usage: seance-expose add <local-port> [https-port]}"
      https_port="${3:-443}"
      case "$https_port" in 443|8443|10000) ;; *)
        echo "https-port must be 443, 8443 or 10000 (tailscale serve limitation)" >&2; exit 1;;
      esac
      sudo tailscale serve --bg --https="$https_port" "http://127.0.0.1:$local_port"
      host="$(fqdn_ts)"
      [[ "$https_port" == 443 ]] && echo "https://$host/" || echo "https://$host:$https_port/"
    fi
    ;;
  rm)
    target="${2:?usage: seance-expose rm <name-or-https-port>}"
    if vanity && [[ -f "$NGINX_DIR/seance-$target.conf" ]]; then
      sudo rm "$NGINX_DIR/seance-$target.conf"
      sudo systemctl reload nginx
      echo "removed $target.$VANITY_DOMAIN"
    else
      sudo tailscale serve --https="$target" off
      echo "removed :$target"
    fi
    ;;
  ls|status)
    if vanity; then
      for f in "$NGINX_DIR"/seance-*.conf; do
        [[ -e "$f" && "$f" != *catchall* ]] || continue
        name=$(basename "$f" .conf); name=${name#seance-}
        port=$(grep -o 'proxy_pass http://127.0.0.1:[0-9]*' "$f" | grep -o '[0-9]*$')
        echo "https://$name.$VANITY_DOMAIN/ -> :$port"
      done
    fi
    tailscale serve status 2>/dev/null || true
    ;;
  *)
    echo "usage: seance-expose {add|rm|ls} (see header of $0)" >&2
    exit 1
    ;;
esac
