# ADR 0007: Seat holds are Postgres row locks inside seat-inventory

## Context

Rule 4: no double booking; a hold must take all requested seats or none, atomically, under concurrency. The brief allows `SELECT ... FOR UPDATE SKIP LOCKED` or a Redis Lua script.

## Decision

`holdSeats` runs in the same transaction that records the `booking.requested` inbox row and writes the `seats.held` / `seats.hold_failed` outbox row. It selects the requested seats that are `available` with `ORDER BY seat_id FOR UPDATE SKIP LOCKED`; if every seat came back it updates them to `held`, otherwise it changes nothing and reports the missing seats. A `CHECK` constraint (`state = 'available'` iff `booking_id IS NULL`) is a last line of defence.

- Fixed lock order (`ORDER BY seat_id`) means overlapping requests cannot deadlock.
- `SKIP LOCKED` makes a contended seat count as unavailable immediately, so a request fails fast instead of queueing.
- The hold, its inbox record and its outgoing event commit together, so there is no window where seats are held but no event exists (or the reverse).

## Trade-offs

- If the request holding a lock later rolls back, a request that skipped that seat has already failed although the seat became available. The buyer retries. We accept a rare false "unavailable" in exchange for never double-booking and never blocking.
- Redis would be faster for hold TTLs, but holds and events could then disagree after a crash. Redis stays in scope for rate limits, the waiting room and, in Phase 4, hold-expiry timing; Postgres remains the source of truth for seat state.
- `hold_expires_at` is recorded now (server time, 10 minutes, configurable). Nothing releases an expired hold yet; that is Phase 4.

## Proof

`services/seat-inventory/test/hold.db.test.ts`: 1,000 concurrent buyers for 100 seats give exactly 100 `seats.held`, 900 `seats.hold_failed`, 100 distinct held seats with distinct owners. A second test with 400 overlapping two-seat requests asserts no seat has two owners and nothing is half-held.
