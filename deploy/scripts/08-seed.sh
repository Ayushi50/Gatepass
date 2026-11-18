#!/usr/bin/env bash
# Publishes the five demo shows (Neon Nights Live, The Laugh Lab, Campus Fest Finale, Jazz on the Roof,
# Midnight Market). Idempotent: shows that already exist are skipped. Optional.
# Needs the catalog service running (it publishes the outbox) and seat-inventory running (it creates the
# seats from the event.published message), so run it AFTER 07-services.sh.
# With Razorpay the seed cannot sell out "Jazz on the Roof" (that needs the fake provider), so it stays on sale.
# Usage: sudo deploy/scripts/08-seed.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_root
APP_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"

for s in catalog seat-inventory; do
  systemctl is-active --quiet "gatepass@$s" || { echo "gatepass@$s is not running; run 07-services.sh" >&2; exit 1; }
done

log "seeding the catalog"
runuser -u gatepass -- bash -c "
  set -a; . /etc/gatepass/catalog.env; set +a
  cd '$APP_DIR' && pnpm --filter @gatepass/catalog seed"

log "seeded. The shows reach seat-inventory through Kafka within a few seconds."
