# ADR 0012: Hold expiry by a database sweeper; a payment that loses the race is refunded

## Context

Seats are held for 10 minutes. Abandoned holds must be released. A payment can also succeed at the very moment its hold is being released (the provider confirms late), and we must decide who wins and make sure the buyer is never charged for seats they do not get.

## Decision

**Expiry.** Seat-inventory runs a sweeper (`HOLD_SWEEP_INTERVAL_MS`, default 1 s). In one transaction per booking it locks the booking's held seats in a fixed order, returns them to sale, and writes `hold.expired` and `seats.released` (reason `hold_expired`) to the outbox. Booking becomes `CANCELLED`, payment closes the payable, analytics returns the seats to the counts. It is durable (no timers to lose in a restart), transactional with its events, and safe on several instances. We chose it over Redis TTL keys, whose expiry notifications are fire-and-forget and lost across restarts; Redis is kept for the waiting room.

**Grace.** The buyer sees the 10-minute `holdExpiresAt`; the sweeper waits an extra `HOLD_GRACE_MS` (default 60 s) so a payment that was already in flight when the hold ended can still land. New payments are refused after `holdExpiresAt`.

**The race.** A sale (`payment.succeeded`) and a sweep both lock the same seat rows and re-check `state = 'held'` after the lock, so exactly one commits first.

- Sale first: the seats are `sold`, the sweep finds nothing.
- Sweep first: the sale finds the seats released, sells nothing and publishes `seats.sale_failed`. Payment then refunds the whole payment automatically (`refund.completed` with `automatic = true`), and the buyer is emailed. The cancelled booking is not resurrected.

A randomised test interleaves the two 150 times and requires exactly one outcome every time (sold, or released and refunded; never both, never neither).

## Trade-offs

- "Honor the payment if the seats are still free" was rejected: it would bring a cancelled booking back to life and re-take seats, for a rare case. A refund is simpler and always correct.
- A buyer whose payment cleared at the provider after the grace window gets their money back instead of a ticket. The grace window makes this rare.
- A sweep that loses a lock race with a sale does nothing for that booking; the next tick has nothing to do either. No work is repeated or lost.
