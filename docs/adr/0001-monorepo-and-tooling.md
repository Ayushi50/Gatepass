# ADR 0001: pnpm monorepo, TypeScript, Jest

## Context

Eight services share an event contract and the outbox/messaging code. They must evolve together and be testable in one CI run.

## Decision

One repo, pnpm workspaces (`apps/*`, `services/*`, `libs/*`). Shared code lives in `libs/*` and is consumed as TypeScript source (`main: src/index.ts`); there is no build step yet. Jest + ts-jest for unit tests (`*.test.ts`). Database tests (`*.db.test.ts`) run against a real Postgres started in-process by `embedded-postgres` (see `libs/testing`), so no Docker is needed locally or in CI. A Testcontainers/Docker Compose setup was tried and removed by decision; it is in git history (commit `a18c883` and earlier). Node 20 is the target (`.nvmrc`, CI).

## Trade-offs

- No build step is fast and simple, but services cannot yet be shipped as compiled images. Each service gets a build and Dockerfile in its own phase.
- Tests that need a real Kafka broker are not run; broker behaviour is covered by an in-memory broker plus the real outbox relay and consumer pipeline.
