#!/usr/bin/env bash
# Installs the systemd unit template and (re)starts all 9 processes. Idempotent.
# Usage: sudo deploy/scripts/07-services.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_root
APP_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
# every process; order is only a courtesy, systemd restarts anything that started too early
PROCESSES=(catalog seat-inventory booking payment ticket notification analytics gateway web)

for p in "${PROCESSES[@]}"; do
  [ -f "/etc/gatepass/$p.env" ] || { echo "missing /etc/gatepass/$p.env, run 05-render-env.sh" >&2; exit 1; }
done

sed "s#@APP_DIR@#$APP_DIR#g" "$DEPLOY_DIR/systemd/gatepass@.service" > /etc/systemd/system/gatepass@.service

# journald keeps logs; cap them so the demo box cannot fill its disk
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/gatepass.conf
systemctl restart systemd-journald

systemctl daemon-reload
for p in "${PROCESSES[@]}"; do
  systemctl enable "gatepass@$p" >/dev/null
  systemctl restart "gatepass@$p"
  echo "started gatepass@$p"
done

log "started. Status: systemctl list-units 'gatepass@*'   Logs: journalctl -u gatepass@gateway -f"
