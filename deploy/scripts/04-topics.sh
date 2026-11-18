#!/usr/bin/env bash
# Creates the Kafka topics: one per event type (topic name = event type, from libs/events/src/catalog.ts)
# plus one dead-letter topic per consumer group. 3 partitions, replication factor 1, like the local stack.
# Idempotent: topics that already exist are skipped. Usage: deploy/scripts/04-topics.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

BROKERS="${KAFKA_BROKERS:-127.0.0.1:9092}"

# Keep in sync with EVENT_CATALOG in libs/events/src/catalog.ts (the smoke test in Phase 6 checks this).
EVENT_TOPICS=(
  event.published
  booking.requested booking.confirmed booking.cancelled
  seats.held seats.hold_failed seats.released seats.sold hold.expired seats.sale_failed
  payment.succeeded payment.failed
  refund.requested refund.approved refund.completed
  ticket.issued ticket.voided
)
# One per consumer group (see CONSUMER_GROUP in each service's handlers.ts)
DLQ_TOPICS=(seat-inventory.dlq booking.dlq payment.dlq ticket.dlq notification.dlq analytics.dlq)

existing="$(rpk topic list --brokers "$BROKERS" | awk 'NR>1 {print $1}')"
for t in "${EVENT_TOPICS[@]}" "${DLQ_TOPICS[@]}"; do
  if grep -qxF "$t" <<<"$existing"; then
    echo "exists  $t"
  else
    rpk topic create "$t" --brokers "$BROKERS" -p 3 -r 1 >/dev/null
    echo "created $t"
  fi
done
log "topics ready (${#EVENT_TOPICS[@]} event + ${#DLQ_TOPICS[@]} dead-letter)"
