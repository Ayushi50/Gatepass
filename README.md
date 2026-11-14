# Gatepass

Ticket booking for live events, built as an event-driven microservices system: Kafka (Redpanda), Postgres per service, Redis, NestJS services, and a Next.js frontend built from the designs in [`design/`](design/).

> **Status: Phase 0 (foundation).** The event contract, outbox/inbox, messaging library, local infrastructure and CI exist. Services arrive in later phases. See `BUILD_PROMPT.md` for the phase plan.

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

Services: catalog, booking (saga orchestrator), seat-inventory, payment, ticket, notification, analytics, gateway. The browser never talks to Kafka; the gateway bridges events to SSE.

## Repo layout

| Path             | Purpose                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `libs/events`    | Protobuf event catalog, generated types, envelope builder and validation |
| `libs/outbox`    | Outbox writer, relay, inbox guard, SQL migration                         |
| `libs/messaging` | KafkaJS publisher and consumer, retry with backoff, DLQ                  |
| `libs/testing`   | Testcontainers helpers (Postgres, Redpanda)                              |
| `infra/`         | Docker Compose, Postgres init, topic and schema bootstrap                |
| `design/`        | Read-only UI source of truth                                             |
| `docs/adr/`      | Architecture decision records                                            |

## Run it

Requirements: Docker, Node 20+, pnpm.

```bash
cp .env.example .env     # optional: compose has the same defaults built in
docker compose up --wait
```

This starts Redpanda (Kafka on `localhost:19092`, schema registry on `localhost:18081`), Postgres on `localhost:15432` (7 databases, one role each), and Redis on `localhost:16379`. A one-shot `redpanda-init` creates the event topics and registers the schema.

## Test it

```bash
pnpm install
pnpm test        # unit tests (no Docker)
pnpm test:int    # integration tests (need Docker; Testcontainers starts Postgres and Redpanda)
pnpm lint        # eslint + prettier
pnpm typecheck
pnpm schema:lint # buf lint
```

To run the Postgres-only integration tests without Docker, point `TEST_DATABASE_URL` at any Postgres server you can create databases on (for example `postgres://postgres:pw@localhost:5432/postgres`). The Kafka integration tests always need Docker.

## Event envelope

Every message is an `EventEnvelope` (see `libs/events/proto/gatepass/events/v1/events.proto`): `eventId` (UUIDv7), `eventType`, `version`, `occurredAtMs`, `correlationId` (the booking ID), `causationId`, `producer`, and a typed `payload`. Topic name equals `eventType`.

CI runs `buf breaking` against the base branch on pull requests, so a breaking schema change fails the build.
