# ADR 0011: Analytics is an event-sourced read model; notifications are a log

## Context

The organizer dashboard needs live counts and a feed. No other service's database may be read (rule 8). The browser must not talk to Kafka.

## Decision

**Analytics** consumes all 15 topics and keeps its own tables:

- `seat_status` per seat (`tier`, `state`, `last_event_ms`). A seat event only applies if it is not older than what is stored, so late, duplicated or replayed events cannot move a seat backwards. Seat events and `event.published` both upsert the row, so a seat event that arrives before `event.published` (topics are consumed in parallel) is not lost, and `event.published` never resets a state.
- `activity`: one line per event, written by the shared `describeActivity`, which the gateway also uses for the live stream, so stored and live lines are identical. Lines carry the id of the event they describe so a client can drop one it already has.
- Every query takes the organizer id from the verified token and refuses any other organizer (403), so one organizer cannot read another's sales.
- Counts are derived from seat states, so sold + held + left always equals the total.

**Live feed.** The gateway consumes the events itself and streams them over SSE. To place an event on a show's feed without a database, every event it shows must carry the show's id, which is why `event_id` was added to `payment.succeeded` / `payment.failed`.

**Notifications** are a log, not a sender: a row is the notification. One row per `(triggering event, channel)` makes redelivery harmless. Rows carry the user id and never the QR token. `ticket.issued` logs an email and an SMS; `payment.failed` logs an email. Wiring a real provider later means sending from the same handler.

## Trade-offs

- Last-writer-wins by the producer's millisecond timestamp can mis-order two events for one seat in the same millisecond. All seat events come from one service and one seat rarely changes twice in a millisecond; accepted.
- The refund-requests tile is not built: refund events carry no show id yet and the reverse saga is Phase 4, which will add them.
- The read model is rebuilt by replaying the topics; there is no separate rebuild tool yet.
