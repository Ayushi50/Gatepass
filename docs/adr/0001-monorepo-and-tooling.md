# ADR 0001: pnpm monorepo, TypeScript, Jest

## Context

Eight services share an event contract and the outbox/messaging code. They must evolve together and be testable in one CI run.

## Decision

One repo, pnpm workspaces (`apps/*`, `services/*`, `libs/*`). Shared code lives in `libs/*` and is consumed as TypeScript source (`main: src/index.ts`); there is no build step yet. Jest + ts-jest, split into a `unit` project (`*.test.ts`, no Docker) and an `integration` project (`*.int.test.ts`, Testcontainers). Node 20 is the target (`.nvmrc`, CI).

## Trade-offs

- No build step is fast and simple, but services cannot yet be shipped as compiled images. Each service gets a build and Dockerfile in its own phase.
- Integration tests need Docker. `TEST_DATABASE_URL` lets Postgres-only tests run against an existing server without Docker.
