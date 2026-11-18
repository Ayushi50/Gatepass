#!/usr/bin/env bash
# Shared helpers, sourced by the other scripts. Not run directly.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="$DEPLOY_DIR/secrets"
SECRETS_FILE="$SECRETS_DIR/secrets.env"

# service name -> database / role name (Postgres names cannot contain "-")
PG_NAMES=(catalog seat_inventory booking payment ticket notification analytics)

log() { printf '\n==> %s\n' "$*"; }

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "run as root (sudo $0)" >&2
    exit 1
  fi
}

# Reads one KEY from the secrets file (empty if missing).
secret() {
  [ -f "$SECRETS_FILE" ] || return 0
  grep -E "^$1=" "$SECRETS_FILE" | head -n1 | cut -d= -f2- || true
}

# True when the apt package is already installed.
have_pkg() { dpkg -s "$1" >/dev/null 2>&1; }
