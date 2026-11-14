# ADR 0003: Transactional outbox, single active relay, inbox for idempotent consumers

## Context

Rule 1: a service must write its data and its outgoing event in one local transaction and never publish to Kafka from a request handler. Rule 2: consumers must ignore duplicates.

## Decision

- `appendToOutbox(tx, envelope, aggregateId)` takes the caller's transaction, so the business write and the event commit or roll back together.
- `OutboxRelay` polls pending rows in `id` order, publishes the batch, and marks the rows published only after the broker acknowledges. Delivery is at-least-once.
- Exactly one relay is active per database, enforced by `pg_try_advisory_xact_lock`. Other replicas idle. We chose this over `FOR UPDATE SKIP LOCKED`, because with SKIP LOCKED two relays can publish batches out of order and break per-aggregate ordering.
- `processOnce(pool, consumer, event, handler)` inserts `(consumer, event_id)` into `inbox` and runs the handler in the same transaction. A duplicate inserts nothing and is skipped. If the handler throws, the inbox row rolls back so the retry runs.

## Trade-offs

- Single active relay caps publish throughput per service at one batch loop. Batching makes this ample for this project; if it ever limits us, shard by aggregate hash.
- A crash after the broker acks but before the rows are marked re-sends a batch. This is why the inbox is mandatory.
- Published rows are kept; a retention job is deferred until it is needed.
