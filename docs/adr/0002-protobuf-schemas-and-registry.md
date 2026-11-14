# ADR 0002: Protobuf events, registered in a schema registry, checked by `buf`

## Context

Rule 11: event schemas must be backward compatible and CI must fail on a breaking change.

## Decision

- All events are Protobuf in one file, `libs/events/proto/gatepass/events/v1/events.proto`. The envelope has a `oneof payload` with one typed message per event. Topic name == event type.
- `buf breaking` (WIRE_JSON rules) runs in CI on pull requests against the base branch. It fails on renumbering, retyping or removing fields. Adding fields or oneof members passes.
- The file can be registered in a schema registry with BACKWARD compatibility so a breaking schema is also rejected at deploy time (no registry is run locally at present).
- Messages on the wire are plain Protobuf bytes of `EventEnvelope`, not the Confluent framing with a schema-ID prefix.

## Trade-offs

- One file and one envelope keep the registry subject and the compatibility story simple, at the cost of every consumer compiling all payloads (cheap, and adding events is non-breaking).
- Skipping the Confluent wire format avoids a registry round trip per message and a client dependency. The registry is therefore the contract and compatibility gate, not a runtime decoder. We can adopt the framing later without changing the schema.
- `occurred_at_ms` is `int64` rather than `google.protobuf.Timestamp`, so the file has no imports and registers as-is.
