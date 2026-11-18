#!/usr/bin/env bash
# Installs Postgres, Redis, Redpanda (single node), Node 22 and pnpm (via corepack) on Ubuntu 24.04.
# Safe to run again. Usage: sudo deploy/scripts/01-install.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_root
export DEBIAN_FRONTEND=noninteractive

if ! grep -q 'Ubuntu' /etc/os-release || ! grep -q '24.04' /etc/os-release; then
  echo "warning: written for Ubuntu 24.04; this is: $(. /etc/os-release && echo "$PRETTY_NAME")" >&2
fi

log "base packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git build-essential openssl ufw

log "swap (2 GB, only if the server has none)"
if [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "swap already present"
fi

log "Postgres"
have_pkg postgresql || apt-get install -y postgresql postgresql-contrib
# default config listens on localhost only; make that explicit and keep it that way
PG_CONF="$(ls /etc/postgresql/*/main/postgresql.conf | head -n1)"
if ! grep -qE "^listen_addresses *= *'localhost'" "$PG_CONF"; then
  sed -i -E "s/^#?listen_addresses *=.*/listen_addresses = 'localhost'/" "$PG_CONF"
  systemctl restart postgresql
fi
systemctl enable --now postgresql

log "Redis (localhost only)"
have_pkg redis-server || apt-get install -y redis-server
sed -i -E 's/^#? *bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
sed -i -E 's/^#? *protected-mode .*/protected-mode yes/' /etc/redis/redis.conf
systemctl enable redis-server
systemctl restart redis-server

log "Node 22 and pnpm"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
# the repo pins its pnpm version in package.json ("packageManager"); corepack fetches exactly that
corepack enable
node -v

log "Redpanda (single node, Kafka API on 127.0.0.1:9092 only)"
if ! have_pkg redpanda; then
  curl -1sLf 'https://dl.redpanda.com/nzc4ZYQK3WRGd9sy/redpanda/cfg/setup/bash.deb.sh' | bash
  apt-get install -y redpanda
fi
# demo-grade: no tuners, capped at 1 GB of RAM and one core so it shares the box with 9 Node processes
rpk redpanda config set redpanda.developer_mode true
rpk redpanda config set redpanda.kafka_api '[{"address":"127.0.0.1","port":9092}]'
rpk redpanda config set redpanda.advertised_kafka_api '[{"address":"127.0.0.1","port":9092}]'
rpk redpanda config set redpanda.admin '[{"address":"127.0.0.1","port":9644}]'
rpk redpanda config set pandaproxy.pandaproxy_api '[{"address":"127.0.0.1","port":8082}]' || true
rpk redpanda config set rpk.additional_start_flags '["--memory=1G","--smp=1","--reserve-memory=0M","--overprovisioned"]'
systemctl enable redpanda
systemctl restart redpanda

log "done. Next: deploy/scripts/02-secrets.sh, then 03-databases.sh and 04-topics.sh"
