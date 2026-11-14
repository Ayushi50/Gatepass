#!/bin/bash
# Idempotent. Creates event topics, sets BACKWARD schema compatibility, registers the event schema.
set -euo pipefail

RPK_ARGS=(-X "brokers=${KAFKA_BROKERS}" -X "registry.hosts=${SCHEMA_REGISTRY}")
SUBJECT="gatepass.events.v1.EventEnvelope"

while IFS= read -r topic; do
  [ -z "$topic" ] && continue
  out=$(rpk "${RPK_ARGS[@]}" topic create "$topic" -p "${TOPIC_PARTITIONS:-3}" -r 1 2>&1) || {
    if echo "$out" | grep -qi "already exists"; then
      echo "topic exists: $topic"
    else
      echo "$out" >&2
      exit 1
    fi
  }
done < /init/topics.txt

rpk "${RPK_ARGS[@]}" registry compatibility-level set "$SUBJECT" --level BACKWARD
rpk "${RPK_ARGS[@]}" registry schema create "$SUBJECT" --schema /init/events.proto --type protobuf

echo "redpanda-init done: $(wc -l < /init/topics.txt) topics, schema registered"
