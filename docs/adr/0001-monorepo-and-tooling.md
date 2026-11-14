# ADR 0001: pnpm monorepo, TypeScript, Jest

## Context

Eight services share an event contract and the outbox/messaging code. They must evolve together and be testable in one CI run.

## Decision

One repo, pnpm workspaces (`apps/*`, `services/*`, `libs/*`). Shared code lives in `libs/*` and is consumed as TypeScript source (`main: src/index.ts`); there is no build step yet. Jest + ts-jest for unit tests (`*.test.ts`). Integration tests with Testcontainers and the Docker Compose stack were tried, then removed by decision; they are in git history (commit `a18c883` and earlier). Node 20 is the target (`.nvmrc`, CI).

## Trade-offs

- No build step is fast and simple, but services cannot yet be shipped as compiled images. Each service gets a build and Dockerfile in its own phase.
- Without integration tests, the outbox, inbox and relay SQL is covered only by unit-level logic. Re-adding them later is straightforward from git history.
