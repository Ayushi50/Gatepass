# Gatepass

Ticket booking for live events, built as an event-driven microservices system: Kafka (Redpanda), Postgres per service, Redis, NestJS services, and a Next.js frontend built from the designs in [`design/`](design/).

> **Status: Phase 2 (payment).** Events and seat maps can be published, seats are held all-or-none under concurrency, and a held booking can be paid (test mode) and confirmed, or cancelled with its seats released when payment fails. Tickets, refunds, hold expiry and the frontend arrive in later phases. See `BUILD_PROMPT.md` for the phase plan.

## Architecture

```
 Browser ──REST/SSE──▶ gateway ──▶ (services, via Kafka events)

 each service:  request ─▶ [ business tables + outbox ]  one DB transaction
                                   │
                                   ▼  OutboxRelay (single active per DB)
                              Kafka / Redpanda ──▶ consumers ─▶ inbox (dedupe) + handler, one transaction
                                                       │ retries w/ backoff
                                                       ▼ exhausted
                                                  <group>.dlq
```

Built so far: **catalog**, **seat-inventory**, **booking** (saga orchestrator), **payment** and **gateway**. Still to come: ticket, notification, analytics. The browser never talks to Kafka; the gateway bridges events to SSE.

### Booking and payment flow

```
POST /api/bookings ─▶ booking: booking(REQUESTED) + outbox booking.requested     (one tx)
   seat-inventory: hold ALL seats or NONE + outbox seats.held | seats.hold_failed (one tx)
   booking: seats.held ─▶ HELD (server-time holdExpiresAt, amount)   payment: seats.held ─▶ payable
   seats.hold_failed ─▶ booking CANCELLED + booking.cancelled

POST /api/bookings/:id/pay (Idempotency-Key) ─▶ payment: payment row, then provider charge
   provider webhook (signed, de-duplicated) ─▶ payment.succeeded | payment.failed
   payment.succeeded ─▶ seat-inventory: held→sold, seats.sold ─▶ booking: PAID → CONFIRMED + booking.confirmed
   payment.failed    ─▶ seat-inventory: held→available, seats.released ─▶ booking CANCELLED + booking.cancelled
```

### Gateway API

| Route                              | Auth     | Notes                                                                                         |
| ---------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `GET /api/events`                  | public   | catalog + live availability; `status`: `available`, `selling_fast`, `sold_out`, `unavailable` |
| `GET /api/events/:id/seats`        | public   | `[{id,row,number,tier,price,state}]`, state `available                                        | held | taken` |
| `GET /api/events/:id/seats/stream` | public   | SSE, `{seatId,state}` per change                                                              |
| `POST /api/bookings`               | attendee | `{eventId, seatIds}` (1 to 6 seats); user comes from the token                                |
| `GET /api/bookings/:id`            | owner    | includes `holdExpiresAt` and `serverTime` (server clock)                                      |

## Repo layout

| Path             | Purpose                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `libs/events`    | Protobuf event catalog, generated types, envelope builder and validation |
| `libs/outbox`    | Outbox writer, relay, inbox guard, SQL migration                         |
| `libs/messaging` | KafkaJS publisher and consumer, retry with backoff, DLQ                  |
| `libs/db`        | Pool factory, SQL migration runner, env helper                           |
| `libs/testing`   | In-process Postgres and in-memory broker for tests                       |
| `services/*`     | catalog, seat-inventory, booking, payment, gateway (NestJS)              |
| `tests/saga`     | Cross-service saga tests                                                 |
| `design/`        | Read-only UI source of truth                                             |
| `docs/adr/`      | Architecture decision records                                            |

## Test it

```bash
pnpm install
pnpm test        # everything: unit tests plus database tests (a real Postgres runs in-process, no Docker)
pnpm lint        # eslint + prettier
pnpm typecheck
pnpm schema:lint # buf lint
```

## Run the services

There is no Docker Compose stack. Provide a Postgres server (one database and role per service) and a Kafka-compatible broker (for example Redpanda), set the variables in `.env.example`, and create the topics in `libs/events` (topic name = event type). Then, per service:

```bash
DATABASE_URL=... KAFKA_BROKERS=... pnpm --filter @gatepass/catalog start
pnpm --filter @gatepass/catalog seed     # publishes the five demo events
```

Mint a development token for the gateway (`JWT_SECRET` must match):

```bash
JWT_SECRET=... pnpm --filter @gatepass/gateway dev-token attendee user-1
```

## Payments (test mode only)

`PAYMENT_PROVIDER=fake` (default for development) or `razorpay` (test keys `rzp_test_...` only; live keys are refused). With `fake`, tokens choose the outcome: `tok_success`, `tok_declined`, `tok_rejected`; set `FAKE_AUTO_WEBHOOK_MS` and the fake provider delivers its own signed webhook after that delay. Point the provider's webhook at `POST /webhooks/<provider>` on the payment service.

## Event envelope

Every message is an `EventEnvelope` (see `libs/events/proto/gatepass/events/v1/events.proto`): `eventId` (UUIDv7), `eventType`, `version`, `occurredAtMs`, `correlationId` (the booking ID), `causationId`, `producer`, and a typed `payload`. Topic name equals `eventType`.

CI runs `buf breaking` against the base branch on pull requests, so a breaking schema change fails the build.
