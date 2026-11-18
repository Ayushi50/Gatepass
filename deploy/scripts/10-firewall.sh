#!/usr/bin/env bash
# ufw: deny all incoming except SSH, 80 and 443 (443/udp for HTTP/3). Idempotent.
# SSH is allowed BEFORE the firewall is switched on, on the port sshd really uses, so you are not locked out.
# NOTE: your VPS provider may also have its own cloud firewall; make sure it allows these three ports too.
# Usage: sudo deploy/scripts/10-firewall.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_root

# the port(s) sshd listens on (default 22)
SSH_PORTS="$(sshd -T 2>/dev/null | awk '$1=="port"{print $2}' | sort -u)"
SSH_PORTS="${SSH_PORTS:-22}"

ufw default deny incoming
ufw default allow outgoing
for p in $SSH_PORTS; do ufw allow "$p/tcp" comment 'ssh'; done
ufw allow 80/tcp comment 'http (certificate + redirect)'
ufw allow 443/tcp comment 'https'
ufw allow 443/udp comment 'http/3'
ufw --force enable

ufw status verbose
log "only SSH ($SSH_PORTS), 80 and 443 are open. Gatepass internals (3000-3007, 3100, 5432, 6379, 9092) are blocked from outside."
log "check from another machine: nc -zv <server-ip> 3000   (should time out)"
