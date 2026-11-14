You are a senior backend engineer building "Gatepass", a ticket booking platform for live events, as a portfolio-grade, event-driven microservices project. Work in a monorepo. Quality, correctness and testability matter more than speed or feature count.

## Product
- Organizers publish events with ticket tiers or seat maps.
- Users pick seats, pay, and receive a QR-code ticket.
- Seats are held for 10 minutes during payment, then released automatically.
- Staff scan QR codes to check people in.
- Organizers see live sales and can issue refunds.

## Stack (change here if needed)
- Language: TypeScript on Node 20, NestJS per service
- Broker: Kafka via Redpanda in Docker Compose; schemas in Protobuf or Avro with a schema registry
- DB: Postgres, one database per service (no shared tables). Redis for seat holds, rate limits, waiting room
- Payments: Razorpay or Stripe in TEST mode only, behind a PaymentProvider interface with a fake implementation for tests
- Frontend (later phase): Next.js, live seat map via SSE. Built from the provided design files (see "Design source of truth")
- Observability: OpenTelemetry, Prometheus, Grafana
- Tests: Jest, Testcontainers for integration, k6 for load
- Local run: one `docker compose up` must start everything

## Design source of truth (frontend)
The folder `gatepass-ui` is provided with this prompt. Copy it into the repo as `/design` (read-only reference). It contains eight finished HTML pages (`index`, `events`, `seats`, `checkout`, `status`, `tickets`, `organizer`, `check-in`), `assets/gatepass.css`, and a `README.md` mapping each page to the API it needs. Read that README before planning any API.

Rules for the frontend (Phase 5, but design the APIs for it from Phase 1):
- These files define the exact look, layout, copy and interactions ("House lights": dark theatre ground, Bodoni Moda + Inter, amber accent, pill buttons). Do not restyle, add colors or fonts, or "improve" the design. Use only the tokens in `assets/gatepass.css`.
- Convert to Next.js components only if the rendered output stays visually identical to the HTML. Keep each page's structure and copy. Replace the sample data arrays and every `// BACKEND:` comment with real API calls. Remove the preview pill switchers on `status.html` and `check-in.html`.
- Accessibility must survive: seat state by shape and icon not color alone (available = ring, selected = amber fill + check, held = dashed amber outline, taken = filled + x), 44px touch targets, visible focus rings, `prefers-reduced-motion`, WCAG AA contrast.
- Add the states the mockups imply but do not show: loading, empty, error, and "hold expired". Add a waiting room page in the same style (position in queue, estimated wait) for the Phase 4 waiting room.
- If a requirement conflicts with the design files, keep the design and tell me.

## Services and events
- catalog: events, venues, seat maps. Publishes event.published
- booking: orders and booking state machine (orchestrator). Publishes booking.requested, booking.confirmed, booking.cancelled
- seat-inventory: seat state available/held/sold. Publishes seats.held, seats.hold_failed, seats.released, seats.sold, hold.expired
- payment: payment attempts, webhooks, refunds. Publishes payment.succeeded, payment.failed, refund.completed
- ticket: issues signed QR tickets. Publishes ticket.issued
- notification: email/SMS log. Consumes only
- analytics: read model for organizer dashboards and the live activity feed. Consumes all
- gateway: auth (JWT, roles attendee / organizer / door-staff), rate limiting, routing, and the REST + SSE API the frontend uses

Happy path: booking.requested -> seats.held -> payment.succeeded -> seats.sold -> booking.confirmed -> ticket.issued -> notification.
Failure path: payment.failed or hold.expired -> seats.released -> booking.cancelled.
Refund path (reverse saga): refund.requested -> organizer approval -> refund.completed -> ticket voided -> seats returned to sale.

## Gateway API contract (match `/design/README.md` exactly)
- `GET /api/events`
- `GET /api/events/:id/seats` and SSE `/api/events/:id/seats/stream`
- `POST /api/bookings {eventId, seatIds}`, `GET /api/bookings/:id` (includes `holdExpiresAt`, server time, not browser clock), `POST /api/bookings/:id/pay` with an `Idempotency-Key` header, SSE `/api/bookings/:id/stream`
- `GET /api/tickets`, `POST /api/tickets/:id/refund`
- `GET /api/organizer/events/:id/summary`, `GET /api/organizer/events/:id/refunds`, `POST /api/refunds/:id/approve`, SSE `/api/organizer/events/:id/activity`
- `POST /api/checkin {qrToken}` (idempotent; a second scan returns "used")

The browser never talks to Kafka. The gateway bridges Kafka events to SSE:
- seats.held / seats.sold / seats.released / hold.expired -> seat map stream
- payment.* / ticket.issued / booking.confirmed / booking.cancelled -> booking status stream
- all events for an event -> organizer activity stream

## Non-negotiable engineering rules
1. Outbox pattern: a service writes its data and its outgoing event in ONE local DB transaction; a relay publishes from the outbox. Never publish to Kafka directly inside a request handler.
2. Idempotent consumers: store processed event IDs (inbox table) and ignore duplicates. Payment calls use idempotency keys.
3. Every event uses a common envelope: eventId, eventType, version, occurredAt, correlationId (the booking ID), causationId, payload.
4. No double booking: seat holds must be atomic under concurrency (SELECT ... FOR UPDATE SKIP LOCKED or optimistic locking; if Redis holds are used, an atomic Lua script that holds all seats or none). Prove it with a test: 1,000 concurrent buyers, 100 seats, exactly 100 successes.
5. Handle the race where payment succeeds just as the hold expires: define and document the behavior (auto-refund or honor if seats still free) and test it.
6. Retries with backoff, then dead-letter topic per consumer, plus a small replay CLI.
7. Payment webhooks: verify signatures; tolerate duplicate, late and out-of-order delivery.
8. Services never read another service's database or call each other synchronously except through the gateway.
9. Correlation IDs and OpenTelemetry traces must follow one booking across all services.
10. No secrets in the repo; use .env.example.
11. Event schemas are backward compatible; CI fails on a breaking schema change.
12. The saga is an explicit, persisted, resumable state machine in the booking service (orchestration). Record why orchestration over choreography in an ADR.

## How you must work
- Work in PHASES (below). Do ONE phase at a time. At the start of each phase, write a short plan (files, tables, events, tests) and wait for my approval before coding.
- Make small commits with clear messages, one logical change each.
- Write tests alongside code. A phase is not done until its acceptance criteria pass; show me the test output.
- Record each significant decision as a short ADR in /docs/adr (context, decision, trade-offs).
- If a requirement is ambiguous or you must choose between two reasonable options, ask me; do not silently guess.
- Do not add features I did not ask for. Do not leave TODO stubs that pretend to work.
- Keep a living README with architecture diagram, how to run, and how to run the tests.

## Phases and acceptance criteria
Phase 0 - Foundation: monorepo layout (`apps/web`, `services/*`, `libs/*`, `infra/`, `design/`, `docs/adr`), Docker Compose (Redpanda, schema registry, Postgres per service, Redis), shared event-envelope and outbox/inbox libraries, CI pipeline. AC: `docker compose up` is healthy; CI runs lint + tests.
Phase 1 - Catalog, seat-inventory, booking: create events and seats, request a booking, hold seats, cancel on hold failure. Expose the read APIs `events.html` and `seats.html` need, including the seat stream. AC: concurrency test passes (no double booking); outbox relay survives a broker restart without losing events.
Phase 2 - Payment: provider interface, fake and test-mode implementations, webhooks, idempotency, payment.failed saga. Expose pay and the booking status stream that `checkout.html` and `status.html` need. AC: duplicate webhook does not double-charge; failure releases seats and cancels the booking.
Phase 3 - Ticket, notification, analytics: signed QR tickets, check-in verification endpoint (atomic, two gates scanning at once cannot both admit), notification log, organizer read model. Expose what `tickets.html`, `check-in.html` and `organizer.html` need. AC: full happy path works end to end in an integration test.
Phase 4 - Resilience: hold-expiry (Redis TTL or delayed message), expiry-vs-payment race handling, refunds as a reverse saga (including organizer approval), DLQ and replay CLI, waiting room for high-demand events (Redis sorted set, admission token required by `POST /api/bookings`, configurable admission rate). AC: chaos script kills a service mid-booking and the system recovers with consistent state.
Phase 5 - Frontend: build from `/design`: event listing, live seat map, checkout with countdown, status page, ticket view with QR, organizer dashboard, door scanner, waiting room. AC: a user can complete a booking in the browser, and the pages are visually identical to the design files.
Phase 6 - Observability and performance: OpenTelemetry traces (context propagated through Kafka headers), Prometheus metrics, Grafana dashboard (bookings per minute, saga success rate, hold-expiry rate, consumer lag, DLQ depth, p95 payment latency), k6 load test, and a results table in the README (throughput, p95 latency, duplicate rate = 0).

## Definition of done (whole project)
- One command starts the system; seed script creates the five demo events from `events.html` (Neon Nights Live, The Laugh Lab, Campus Fest Finale, Jazz on the Roof [sold out], Midnight Market) with an A-F seat layout and Front / Mid / Back tiers.
- All acceptance criteria above pass in CI.
- README includes architecture diagram, event catalog with payload schemas, saga flows, a "what happens when X fails" table, trade-offs, and measured results.

## Start now
Do Phase 0 only. First reply with: (1) the proposed repo structure, (2) the event envelope definition, (3) the outbox and inbox table schemas, (4) your plan for the phase. Then wait for my approval.
