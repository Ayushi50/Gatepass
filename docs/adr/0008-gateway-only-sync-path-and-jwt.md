# ADR 0008: The gateway is the only synchronous path; JWT identifies the user

## Context

Rule 8: services never call each other synchronously except through the gateway. The gateway also owns auth.

## Decision

- Services publish and consume events only. The browser's REST and SSE traffic goes to the gateway, which calls catalog, seat-inventory and booking over plain HTTP and composes the answers (for example the show list = catalog events + seat-inventory availability).
- The gateway verifies HS256 JWTs itself (`sub` = user id, `role` = attendee | organizer | door-staff). The algorithm is pinned, signatures are compared in constant time, and `exp` is enforced. Routes opt in with `@Roles(...)`; the rest are public.
- The user id for a booking comes from the verified token, never from the request body.
- The seat stream is Kafka -> in-process hub -> SSE. Each gateway instance uses its own consumer group so every instance sees every event, and it starts at the end of the topic; the REST seat map provides the initial state.
- There is no login endpoint yet. `pnpm --filter @gatepass/gateway dev-token <role> <userId>` mints a development token.

## Trade-offs

- Hand-rolled JWT verification keeps dependencies small and is covered by tests (tampering, `alg: none`, wrong algorithm, expiry), but a maintained library is the better choice if more algorithms or key rotation are needed.
- A shared HS256 secret means anything that can verify tokens can also mint them. A later login service should move to asymmetric keys.
- Heartbeat `ping` events keep idle SSE connections open through proxies.
