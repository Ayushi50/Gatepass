#!/usr/bin/env bash
# Installs Caddy (official apt repo) and the Gatepass Caddyfile for your DOMAIN, then reloads it.
# Idempotent. Usage: sudo deploy/scripts/09-caddy.sh   (needs deploy/.env.production with DOMAIN)
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_root
export DEBIAN_FRONTEND=noninteractive

PROD_ENV="$DEPLOY_DIR/.env.production"
[ -f "$PROD_ENV" ] || { echo "create $PROD_ENV first" >&2; exit 1; }
DOMAIN="$(grep -E '^DOMAIN=' "$PROD_ENV" | head -n1 | cut -d= -f2- | tr -d '\r')"
case "$DOMAIN" in ''|*example.com|*://*|*/*) echo "set a real bare DOMAIN in $PROD_ENV" >&2; exit 1;; esac

if ! have_pkg caddy; then
  log "installing Caddy"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

install -d -o caddy -g caddy /var/log/caddy
sed "s#@DOMAIN@#$DOMAIN#g" "$DEPLOY_DIR/caddy/Caddyfile" > /etc/caddy/Caddyfile

log "validating"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl reload-or-restart caddy

log "HTTPS is on for https://$DOMAIN (the certificate is issued on the first request; give it a minute)"
log "Razorpay webhook URL to register: https://$DOMAIN/webhooks/razorpay"
