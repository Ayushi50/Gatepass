# ADR 0014: Waiting room in Redis, admission required to book

## Context

A high-demand show must not let everyone hit booking at once. People should queue fairly, be let in at a controlled rate, and prove their admission when booking.

## Decision

- A show is marked `waitingRoom` by its organizer (published in `event.published`, shown in `GET /api/events`).
- The queue is a Redis sorted set per event, scored by a strictly increasing arrival counter, so it is first come, first served. Joining is a Lua script and idempotent (you keep your place). Estimated wait is `ceil(position / admitPerSecond)`.
- An admitter drains it at `WAITING_ROOM_ADMIT_PER_SECOND` (default 5) with a per-event credit that accrues with elapsed time (fractional rates work, and a quiet spell never stores a burst). Popping from the queue and marking people admitted is one Lua script. A Redis lease makes exactly one gateway instance admit at a time, so the rate is never doubled.
- Admission is a Redis key with a TTL (`WAITING_ROOM_ADMISSION_TTL_SECONDS`, default 5 min) plus a signed token (`typ: admission`, bound to one user and one show, no role). `POST /api/bookings` for a waiting-room show requires `X-Admission-Token`: the signature, the user, the show and the expiry are checked AND the Redis key must still exist, so a pass ends when the admission ends. An access token cannot pass as an admission or the reverse. Other shows are unaffected.

## Trade-offs

- The pass is reusable until it expires, so a buyer whose hold fails (seat taken) can retry without queueing again; it also means one admission can place more than one booking. Per-person limits are not enforced.
- The queue is only as durable as Redis. Losing it loses places, not bookings.
- The Lua scripts build one key from an argument (the admitted key), so they target a single Redis node, not a cluster.
