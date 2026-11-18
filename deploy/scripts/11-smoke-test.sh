#!/usr/bin/env bash
# Post-deploy smoke test: systemd state, Kafka topics, then deploy/smoke/smoke-test.mjs
# (health, gateway -> services, webhook signatures, hold -> pay -> ticket).
# Reads secrets from /etc/gatepass without printing them. Usage: sudo deploy/scripts/11-smoke-test.sh
# NOTE: the booking test sells one seat of a demo show (and leaves an unpaid Razorpay TEST order).
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_root
APP_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
fail=0

envval() { grep -E "^$2=" "/etc/gatepass/$1.env" | head -n1 | cut -d= -f2-; }

log "[0a] systemd: all 9 processes active"
for p in catalog seat-inventory booking payment ticket notification analytics gateway web; do
  if systemctl is-active --quiet "gatepass@$p"; then echo "PASS  gatepass@$p active"
  else echo "FAIL  gatepass@$p is $(systemctl is-active "gatepass@$p")"; fail=1; fi
done
for u in postgresql redis-server redpanda caddy; do
  if systemctl is-active --quiet "$u"; then echo "PASS  $u active"; else echo "FAIL  $u is $(systemctl is-active "$u")"; fail=1; fi
done

log "[0b] Kafka topics exist (compared with EVENT_CATALOG in libs/events/src/catalog.ts)"
expected="$(grep -oE "^  '[a-z_]+\.[a-z_]+': \{" "$APP_DIR/libs/events/src/catalog.ts" | tr -d " ':{" | sort)"
[ -n "$expected" ] || { echo "FAIL  could not read the event list from catalog.ts"; fail=1; }
have="$(rpk topic list --brokers 127.0.0.1:9092 | awk 'NR>1 {print $1}' | sort)"
for t in $expected seat-inventory.dlq booking.dlq payment.dlq ticket.dlq notification.dlq analytics.dlq; do
  if grep -qxF "$t" <<<"$have"; then :; else echo "FAIL  missing topic $t"; fail=1; fi
done
[ "$fail" = 0 ] && echo "PASS  all $(echo "$expected" | wc -l) event topics and 6 dead-letter topics exist"

DOMAIN="$(grep -E '^DOMAIN=' "$DEPLOY_DIR/.env.production" | head -n1 | cut -d= -f2- | tr -d '\r')"
export JWT_SECRET="$(envval gateway JWT_SECRET)"
export RAZORPAY_WEBHOOK_SECRET="$(envval payment RAZORPAY_WEBHOOK_SECRET)"
export PUBLIC_URL="${PUBLIC_URL:-https://$DOMAIN}"

log "[1-4] application checks"
node "$DEPLOY_DIR/smoke/smoke-test.mjs" || fail=1

[ "$fail" = 0 ] && log "SMOKE TEST PASSED (see the 'NOT covered' list above, then deploy/CHECKLIST.md)" \
  || { log "SMOKE TEST HAD FAILURES"; exit 1; }
