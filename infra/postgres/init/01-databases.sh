#!/bin/bash
# Creates one database and one login role per service. Runs once, on first start of an empty volume.
set -euo pipefail

# service-name:PASSWORD_ENV_VAR
SERVICES=(
  "catalog:PG_CATALOG_PASSWORD"
  "booking:PG_BOOKING_PASSWORD"
  "seat_inventory:PG_SEAT_INVENTORY_PASSWORD"
  "payment:PG_PAYMENT_PASSWORD"
  "ticket:PG_TICKET_PASSWORD"
  "notification:PG_NOTIFICATION_PASSWORD"
  "analytics:PG_ANALYTICS_PASSWORD"
)

for entry in "${SERVICES[@]}"; do
  name="${entry%%:*}"
  pw_var="${entry##*:}"
  password="${!pw_var}"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE ${name} LOGIN PASSWORD '${password}';
CREATE DATABASE ${name} OWNER ${name};
-- No other role may even connect to this database.
REVOKE ALL ON DATABASE ${name} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${name} TO ${name};
SQL
done
