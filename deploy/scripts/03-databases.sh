#!/usr/bin/env bash
# Creates one Postgres role and one database per data service, the role owning its database.
# Idempotent: existing roles/databases are kept and passwords are re-synced from the secrets file.
# Usage: sudo deploy/scripts/03-databases.sh   (run 02-secrets.sh first)
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_root
[ -f "$SECRETS_FILE" ] || { echo "run 02-secrets.sh first" >&2; exit 1; }

psql_admin() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 -X -q "$@"; }

for n in "${PG_NAMES[@]}"; do
  upper="$(echo "$n" | tr '[:lower:]' '[:upper:]')"
  pw="$(secret "PG_PASSWORD_$upper")"
  [ -n "$pw" ] || { echo "missing PG_PASSWORD_$upper in secrets file" >&2; exit 1; }

  log "role and database: $n"
  # passwords are hex, so they are safe inside a SQL string; piping via stdin keeps them out of argv
  if [ "$(psql_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname='$n'")" = "1" ]; then
    echo "ALTER ROLE $n WITH LOGIN PASSWORD '$pw'" | psql_admin >/dev/null
  else
    echo "CREATE ROLE $n WITH LOGIN PASSWORD '$pw'" | psql_admin >/dev/null
  fi
  if [ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname='$n'")" != "1" ]; then
    psql_admin -c "CREATE DATABASE $n OWNER $n" >/dev/null
  fi
  # keep other roles out of this database (one database per service, no shared tables)
  psql_admin -c "REVOKE ALL ON DATABASE $n FROM PUBLIC" >/dev/null
  psql_admin -c "GRANT ALL ON DATABASE $n TO $n" >/dev/null
done

log "databases ready: ${PG_NAMES[*]}"
log "tables are created by each service on its first start (it migrates itself)"
