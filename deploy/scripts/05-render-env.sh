#!/usr/bin/env bash
# Creates the `gatepass` system user and writes one env file per process to /etc/gatepass/<name>.env
# from deploy/.env.production (your values) and deploy/secrets/secrets.env (generated).
# Each process gets ONLY the variables it needs. Idempotent: files are rewritten each run.
# Usage: sudo deploy/scripts/05-render-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_root

PROD_ENV="$DEPLOY_DIR/.env.production"
ENV_DIR=/etc/gatepass
[ -f "$PROD_ENV" ] || { echo "create $PROD_ENV from .env.production.example first" >&2; exit 1; }
[ -f "$SECRETS_FILE" ] || { echo "run 02-secrets.sh first" >&2; exit 1; }

# read KEY from .env.production without executing the file
user() { grep -E "^$1=" "$PROD_ENV" | head -n1 | cut -d= -f2- | tr -d '\r' || true; }
# like user(), with a default
userd() { local v; v="$(user "$1")"; echo "${v:-$2}"; }
require() { # require KEY -> value or exit
  local v; v="$(user "$1")"
  [ -n "$v" ] || { echo "missing $1 in $PROD_ENV" >&2; exit 1; }
  case "$v" in *example.com*|*your-*|*paste-*|*xxxx*) echo "$1 still has its placeholder value" >&2; exit 1;; esac
  echo "$v"
}

DOMAIN="$(require DOMAIN)"
case "$DOMAIN" in *://*|*/*) echo "DOMAIN must be a bare host name" >&2; exit 1;; esac
GOOGLE_CLIENT_ID="$(require GOOGLE_CLIENT_ID)"
GOOGLE_CLIENT_SECRET="$(require GOOGLE_CLIENT_SECRET)"
RAZORPAY_KEY_ID="$(require RAZORPAY_KEY_ID)"
RAZORPAY_KEY_SECRET="$(require RAZORPAY_KEY_SECRET)"
RAZORPAY_WEBHOOK_SECRET="$(require RAZORPAY_WEBHOOK_SECRET)"
case "$RAZORPAY_KEY_ID" in rzp_test_*) ;; *) echo "RAZORPAY_KEY_ID must start with rzp_test_ (live keys are refused)" >&2; exit 1;; esac
[ "${#RAZORPAY_WEBHOOK_SECRET}" -ge 32 ] || { echo "RAZORPAY_WEBHOOK_SECRET should be 32+ chars (openssl rand -hex 32)" >&2; exit 1; }
ORGANIZER_EMAILS="$(user ORGANIZER_EMAILS)"
[ -n "$ORGANIZER_EMAILS" ] || echo "warning: ORGANIZER_EMAILS is empty, nobody can reach the organizer dashboard" >&2
DOOR_STAFF_EMAILS="$(user DOOR_STAFF_EMAILS)"
JWT_SECRET="$(secret JWT_SECRET)"
TICKET_SECRET="$(secret TICKET_SIGNING_SECRET)"
INTERNAL_TOKEN="$(secret INTERNAL_TOKEN)"
[ -n "$JWT_SECRET" ] && [ -n "$TICKET_SECRET" ] && [ -n "$INTERNAL_TOKEN" ] || { echo "secrets file is incomplete; run 02-secrets.sh" >&2; exit 1; }

id gatepass >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/gatepass --shell /usr/sbin/nologin gatepass
install -d -m 750 -o root -g gatepass "$ENV_DIR"

HEAP="$(userd NODE_HEAP_MB 320)"
BROKERS=127.0.0.1:9092

write() { # write NAME  (env lines on stdin)
  local f="$ENV_DIR/$1.env"
  { echo "NODE_ENV=production"; echo "NODE_OPTIONS=--max-old-space-size=$HEAP"; cat; } > "$f"
  chown gatepass:gatepass "$f"
  chmod 600 "$f"
  echo "wrote $f"
}
dburl() { # dburl <service-name> <db-name>
  local up; up="$(echo "$2" | tr '[:lower:]' '[:upper:]')"
  echo "DATABASE_URL=postgres://$2:$(secret "PG_PASSWORD_$up")@127.0.0.1:5432/$2"
}

write catalog <<EOF
PORT=3001
KAFKA_BROKERS=$BROKERS
INTERNAL_TOKEN=$INTERNAL_TOKEN
$(dburl catalog catalog)
EOF
write seat-inventory <<EOF
PORT=3002
KAFKA_BROKERS=$BROKERS
INTERNAL_TOKEN=$INTERNAL_TOKEN
$(dburl seat-inventory seat_inventory)
HOLD_TTL_MS=$(userd HOLD_TTL_MS 600000)
HOLD_SWEEP_INTERVAL_MS=$(userd HOLD_SWEEP_INTERVAL_MS 1000)
HOLD_GRACE_MS=$(userd HOLD_GRACE_MS 60000)
EOF
write booking <<EOF
PORT=3003
KAFKA_BROKERS=$BROKERS
INTERNAL_TOKEN=$INTERNAL_TOKEN
$(dburl booking booking)
EOF
write payment <<EOF
PORT=3004
KAFKA_BROKERS=$BROKERS
INTERNAL_TOKEN=$INTERNAL_TOKEN
$(dburl payment payment)
PAYMENT_PROVIDER=razorpay
RAZORPAY_KEY_ID=$RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET=$RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET=$RAZORPAY_WEBHOOK_SECRET
EOF
write ticket <<EOF
PORT=3005
KAFKA_BROKERS=$BROKERS
INTERNAL_TOKEN=$INTERNAL_TOKEN
$(dburl ticket ticket)
TICKET_SIGNING_KEYS=k1:$TICKET_SECRET
EOF
write notification <<EOF
METRICS_PORT=3006
KAFKA_BROKERS=$BROKERS
INTERNAL_TOKEN=$INTERNAL_TOKEN
$(dburl notification notification)
EOF
write analytics <<EOF
PORT=3007
KAFKA_BROKERS=$BROKERS
INTERNAL_TOKEN=$INTERNAL_TOKEN
$(dburl analytics analytics)
EOF
write gateway <<EOF
PORT=3000
KAFKA_BROKERS=$BROKERS
INTERNAL_TOKEN=$INTERNAL_TOKEN
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=$JWT_SECRET
CATALOG_URL=http://127.0.0.1:3001
SEAT_INVENTORY_URL=http://127.0.0.1:3002
BOOKING_URL=http://127.0.0.1:3003
PAYMENT_URL=http://127.0.0.1:3004
TICKET_URL=http://127.0.0.1:3005
ANALYTICS_URL=http://127.0.0.1:3007
PAYMENT_PROVIDER=razorpay
RAZORPAY_KEY_ID=$RAZORPAY_KEY_ID
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=https://$DOMAIN/api/auth/google/callback
ORGANIZER_EMAILS=$ORGANIZER_EMAILS
DOOR_STAFF_EMAILS=$DOOR_STAFF_EMAILS
WAITING_ROOM_ADMIT_PER_SECOND=$(userd WAITING_ROOM_ADMIT_PER_SECOND 5)
WAITING_ROOM_ADMISSION_TTL_SECONDS=$(userd WAITING_ROOM_ADMISSION_TTL_SECONDS 300)
RATE_LIMIT_PER_MINUTE=$(userd RATE_LIMIT_PER_MINUTE 600)
RATE_LIMIT_SIGNINS_PER_MINUTE=$(userd RATE_LIMIT_SIGNINS_PER_MINUTE 200)
EOF
# The web app reads these at BUILD time (06-build.sh sources this file) and GATEWAY_URL/HOSTNAME at run time.
write web <<EOF
HOSTNAME=127.0.0.1
GATEWAY_URL=http://127.0.0.1:3000
NEXT_PUBLIC_TIMEZONE=$(userd NEXT_PUBLIC_TIMEZONE Asia/Kolkata)
NEXT_PUBLIC_HOLD_SECONDS=$(userd NEXT_PUBLIC_HOLD_SECONDS 600)
EOF

log "env files written to $ENV_DIR (root/gatepass only). Values were not printed."
