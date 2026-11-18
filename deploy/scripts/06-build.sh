#!/usr/bin/env bash
# Installs dependencies, generates the event code and builds the Next.js app, as the `gatepass` user.
# Re-run after every `git pull`. Database migrations are NOT a separate step: each service applies its
# own migrations/*.sql when it starts (see libs/db migrate()), so 07-services.sh restarting them is enough.
# Usage: sudo deploy/scripts/06-build.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_root
APP_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
[ -f /etc/gatepass/web.env ] || { echo "run 05-render-env.sh first" >&2; exit 1; }

# the app tree must belong to the service user (secrets/ stays root-only)
chown -R gatepass:gatepass "$APP_DIR"
chown -R root:root "$SECRETS_DIR" 2>/dev/null || true
chmod o+x "$(dirname "$APP_DIR")" 2>/dev/null || true

log "pnpm install (dev dependencies are needed: services run through ts-node)"
runuser -u gatepass -- bash -c "cd '$APP_DIR' && pnpm install --frozen-lockfile"

log "pnpm generate (event schemas -> libs/events/src/gen)"
runuser -u gatepass -- bash -c "cd '$APP_DIR' && pnpm generate"

log "Next.js production build (GATEWAY_URL and NEXT_PUBLIC_* are fixed into the build here)"
# do NOT export NODE_ENV=production before pnpm install above: it would skip ts-node/typescript
runuser -u gatepass -- bash -c "
  set -a; . /etc/gatepass/web.env; set +a
  cd '$APP_DIR' && pnpm --filter @gatepass/web build"

log "build done. Next: sudo deploy/scripts/07-services.sh"
