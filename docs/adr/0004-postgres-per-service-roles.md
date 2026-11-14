# ADR 0004: One Postgres server, one database and one role per service

## Context

Rule 8: services never read another service's database. The brief asks for "one database per service".

## Decision

Local Compose runs a single Postgres container with seven databases (catalog, booking, seat_inventory, payment, ticket, notification, analytics). Each has its own login role. `CONNECT` is revoked from `PUBLIC`, so a role cannot even connect to another service's database. Passwords come from env vars with throwaway dev defaults (`.env.example`).

## Trade-offs

- Seven containers would be stricter isolation but cost far more memory on a laptop. Roles give the same access isolation.
- Services in production-like setups should use separate servers. Each service only ever receives its own connection string, so this is a deployment change, not a code change.
