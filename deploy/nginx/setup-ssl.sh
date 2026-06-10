#!/usr/bin/env bash
# Idempotent Nginx + Let's Encrypt SSL setup for a single-service droplet.
# Usage: setup-ssl.sh <domain> <upstream_port> <certbot_email>
set -euxo pipefail

DOMAIN="${1:?Usage: setup-ssl.sh <domain> <upstream_port> <certbot_email>}"
UPSTREAM_PORT="${2:?Missing upstream_port}"
CERTBOT_EMAIL="${3:?Missing certbot_email}"
CONF_FILE="/etc/nginx/conf.d/${DOMAIN}.conf"

echo "▸ Setting up Nginx + SSL for ${DOMAIN} → 127.0.0.1:${UPSTREAM_PORT}"

# ── 1. Install Nginx & Certbot if missing ──────────────────────────────────
if ! command -v nginx &>/dev/null || ! command -v certbot &>/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx certbot python3-certbot-nginx
fi

mkdir -p /var/www/certbot
mkdir -p /etc/nginx/conf.d

# Remove legacy sites-enabled default to avoid conflicts with conf.d
rm -f /etc/nginx/sites-enabled/default

# ── 2. Stop any process on port 80 that isn't Nginx (e.g. old Docker bind) ─
if ss -tlnp | grep ':80 ' | grep -qv nginx; then
  echo "▸ Port 80 in use by non-Nginx process; freeing it"
  fuser -k 80/tcp 2>/dev/null || true
  sleep 1
fi

# ── 3. Obtain certificate if not already present ───────────────────────────
CERT_EXISTS=false
if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  CERT_EXISTS=true
fi

if [ "$CERT_EXISTS" = false ]; then
  echo "▸ Obtaining Let's Encrypt certificate for ${DOMAIN}"

  cat > "${CONF_FILE}" <<CONF
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 444;
    }
}
CONF

  nginx -t
  systemctl reload nginx 2>/dev/null || systemctl start nginx

  certbot certonly --webroot -w /var/www/certbot \
    -d "${DOMAIN}" \
    --non-interactive --agree-tos -m "${CERTBOT_EMAIL}"
fi

# ── 4. Write full Nginx config (HTTP redirect + HTTPS reverse proxy) ──────
cat > "${CONF_FILE}" <<CONF
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    client_max_body_size 50M;

    location / {
        proxy_pass         http://127.0.0.1:${UPSTREAM_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;

        # Long timeouts for SSE / WebSocket streams
        proxy_read_timeout  86400;
        proxy_send_timeout  86400;
        proxy_buffering     off;
    }
}
CONF

# ── 5. Activate Nginx ─────────────────────────────────────────────────────
nginx -t
systemctl enable nginx
systemctl reload nginx 2>/dev/null || systemctl start nginx

# ── 6. Enable auto-renewal ────────────────────────────────────────────────
systemctl enable certbot.timer 2>/dev/null || true
systemctl start  certbot.timer 2>/dev/null || true

echo "✓ SSL ready: https://${DOMAIN} → 127.0.0.1:${UPSTREAM_PORT}"
