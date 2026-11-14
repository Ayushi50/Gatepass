# ADR 0013: Refunds are a reverse saga orchestrated by booking, with organizer approval

## Context

A buyer can ask to refund one ticket; the organizer must approve; the money goes back; the ticket dies; the seat returns to sale. Each step is in a different service.

## Decision

`refund.requested` (ticket) -> organizer approves (booking) -> `refund.approved` -> payment refunds -> `refund.completed` -> ticket voided (`ticket.voided`), seat released (`seats.released`, reason `refunded`), booking marks it done, analytics and notification update.

- **Request locks the ticket.** In one transaction the ticket goes `valid -> refund_requested` (a conditional UPDATE, like check-in) and `refund.requested` is written to the outbox. So a refund request and a door scan racing on one ticket have exactly one winner, and a ticket with a pending refund cannot be scanned. A used ticket cannot be refunded.
- **Booking orchestrates.** Its `refunds` table (`REQUESTED -> APPROVED -> COMPLETED`, never backwards) is the persisted saga. Only the show's organizer (carried in `refund.requested`) can approve; approving twice just reports the state.
- **Payment is idempotent.** The refund id is the provider-side idempotency key; the refund row is created once; `refund.completed` is published only by whoever flips `PENDING -> COMPLETED`; the total refunded can never exceed what was paid (checked under a lock on the payment). A provider that answers `pending` completes later through a signed `refund.processed` webhook. The provider is never called inside a database transaction.
- **One refund per ticket** (`UNIQUE (ticket_id)`), full ticket price, no partial amounts.

## Trade-offs

- There is no "reject": the design has only Approve. A requested refund locks the ticket even if the organizer is slow.
- A provider refund that is rejected outright has no `refund.failed` event; it is retried, then dead-lettered, then replayed once fixed (ADR 0015).
- A partial refund leaves the booking `CONFIRMED`.
