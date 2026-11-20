#!/usr/bin/env bash
# Generates deploy/secrets/secrets.env (git-ignored, mode 600) with random passwords and keys.
# Idempotent: values that already exist are kept, only missing ones are added.
# Prints key NAMES only, never values. Usage: deploy/scripts/02-secrets.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
touch "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"

ensure() { # ensure KEY BYTES  -> random hex value if the key is missing
  local key="$1" bytes="$2"
  if [ -z "$(secret "$key")" ]; then
    printf '%s=%s\n' "$key" "$(openssl rand -hex "$bytes")" >> "$SECRETS_FILE"
    echo "generated $key"
  else
    echo "kept      $key"
  fi
}

for n in "${PG_NAMES[@]}"; do
  ensure "PG_PASSWORD_$(echo "$n" | tr '[:lower:]' '[:upper:]')" 24
done
ensure JWT_SECRET 32                 # 64 hex chars (gateway needs 32+)
ensure INTERNAL_TOKEN 32            # gateway -> internal services shared secret
ensure TICKET_SIGNING_SECRET 32      # becomes TICKET_SIGNING_KEYS=k1:<this> (needs 32+)

# Razorpay and Google values are NOT generated: you paste them into deploy/.env.production later.
log "secrets are in $SECRETS_FILE (not printed, not committed)"
