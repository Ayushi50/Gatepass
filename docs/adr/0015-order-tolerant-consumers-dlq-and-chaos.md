# ADR 0015: Consumers tolerate any arrival order; dead letters are replayed; chaos proves it

## Context

Events from different topics have no common order. A message that fails its retries goes to a dead-letter topic and may be replayed long after later events were handled. Rule 6 asks for retries, a DLQ per consumer and a replay tool; the whole design assumes the system ends consistent however messages are delayed, duplicated or reordered.

## Decision

- **Replay.** `pnpm replay --dlq <group>.dlq [--limit N] [--event-id ID] [--dry-run]` republishes dead letters to their original topic with the original bytes and key. It reads with its own consumer group (so a second run does not repeat) and moves that group's position forward only after the broker accepted the republished messages. Other consumers on the topic see the message again; their inboxes ignore it.
- **Order-tolerant handlers.** Chaos testing found that booking could end stuck in `PAID` or `HELD` when `payment.succeeded`, `seats.sold` or `seats.released` were seen before `seats.held` (after a replay). Every booking handler now applies its fact whenever it arrives, and the state machine makes the end state the same in any order: facts that end a booking (sold, released) win over facts that only advance it (held, paid); a late fact never undoes an earlier one; a late `seats.held` only fills in the hold details. `seats.sold` now carries the amount so confirming needs no earlier event. Payment leaves a closed tombstone if a release overtakes `seats.held`, so a released booking can never become payable.
- **Chaos.** `tests/chaos` drives the whole system (all services, real databases, the real relays and consumer pipeline, an in-memory broker) with random users while injecting handler crashes before and after commit, relay crashes after publishing, broker outages, duplicate delivery, late/duplicate/contradicting webhooks and expiring holds. Then it replays the dead letters, settles, and `checkInvariants` demands a consistent world: no half-finished booking, payment or refund, no double sale, every ticket matches a seat, a cancelled booking owns nothing and was refunded in full, money in minus money out equals the value of the sold seats, the provider's captures equal our successes, nothing unsent in any outbox, the dashboard agrees. Runs are seeded and replayable (`CHAOS_SEED=7`). A test corrupts a finished run five ways to prove the checker is not vacuous.

## Trade-offs

- The in-process chaos uses an in-memory broker, so it proves the logic and the transactions, not Kafka itself. A chaos run that kills real service processes against a real Kafka broker was planned and deliberately skipped, so Kafka-specific behaviour (consumer-group rebalances, partition ordering, offset commits) is untested here.
- Replaying republishes to every consumer of the topic, which relies on inboxes everywhere. That is already a rule for every consumer.
