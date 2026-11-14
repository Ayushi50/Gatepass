# ADR 0017: Traces follow the event, metrics count after commit, and the load test reads the databases

## Context

A booking crosses seven services, mostly through Kafka. Without telemetry a slow or stuck booking is invisible, and without a load test "no double-sell" is only claimed at low volume.

## Decision

- **OpenTelemetry traces, carried through Kafka by the outbox.** The W3C `traceparent` is written into the outbox row's headers in the same transaction as the event, so the trace survives relay delay, a relay restart and redelivery. Consumers continue it. Tracing is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Two traces per purchase, on purpose.** The booking request (gateway → booking → seat-inventory → payment) is one trace. The payment starts at the provider's webhook, which is an outside call, so it begins a second trace (payment → seat-inventory → booking → ticket → notification). They share the booking's correlation id.
- **Prometheus metrics, counted only after the database commit** and only when the inbox says the message was new, so a redelivered message never counts twice (tested). Each service exposes an unauthenticated `GET /metrics` (notification, which has no HTTP API, serves it on `METRICS_PORT`, default 3006). In production these ports would be reachable only from the monitoring network.
- **Counters start at zero.** Prometheus cannot see the first increase of a series that did not exist a moment earlier, so every outcome a rate is built on (cancelled by reason, expired, payment outcome) is published as 0 at start-up. The observability check caught this: the first cancellation after a start was missing from the success rate.
- **Lag and dead letters are read at scrape time** from Kafka (`gatepass_consumer_lag`, `gatepass_dlq_depth`), and unsent outbox rows from Postgres (`gatepass_outbox_pending`), so they are right even when the service doing the work is stuck.
- **One dashboard, kept in the repo** (`infra/observability/grafana`): bookings per minute, saga success rate, hold-expiry rate, consumer lag, DLQ depth, p95 payment latency. `pnpm stack -- --observability` starts Jaeger, Prometheus and Grafana as plain programs (downloaded once, checksums verified, no Docker).
- **Proven, not claimed.** `pnpm observability:check` boots everything, makes a paid, a declined and an abandoned booking, then fails unless every dashboard query returns data, the success rate is below 100%, the expiry rate is above 0, Grafana loaded the dashboard, and both traces reach the services they should.
- **The load test judges by the databases.** `pnpm loadtest` runs k6 (up to 50 buyers on one 1,000-seat show, one payment in five sent twice at once) and then counts, in Postgres, seats held by two confirmed bookings and bookings with two successful charges. Duplicate rate = (those two) ÷ confirmed bookings, and it must be 0. It also requires charges = confirmed bookings and tickets = sold seats.

## Consequences and limits

- Numbers in the README are from one laptop: one Kafka broker, an embedded Postgres without fsync, a fake payment provider answering in 100 ms. They show the system stays correct under contention; they are not capacity figures.
- Ratios over a 5-minute window are extrapolated by Prometheus, so in the first minutes after a start they are approximate.
- Not built: alert rules, log aggregation, running k6 or the observability stack in CI.
