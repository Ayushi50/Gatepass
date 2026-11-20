# Gatepass review report

## Verdict

Every feature works and is proven by a test or a real run, and the code is professional in structure, tests and docs; but two things stop it being production-ready: CI on GitHub was red and the fix is unverified until pushed, and the internal services trust any caller who reaches their ports. It does not meet the BUILD_PROMPT items for Docker Compose, Redpanda, a schema registry and Testcontainers (removed earlier at your request), and only a fake payment provider exists. Findings are in `02-findings.md`; nothing is hidden.

## Features and acceptance criteria: before and after

| Item                                               | Before                                                        | After                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Lint, types, 381 backend and 34 web tests          | PASS                                                          | PASS (388 backend with the new tests)                                         |
| 1,000 buyers / 100 seats, exactly 100 win          | PASS                                                          | PASS                                                                          |
| Outbox survives broker restart                     | PASS (test)                                                   | PASS (test, and a real broker kill)                                           |
| Duplicate webhook, payment failure, expiry race    | PASS                                                          | PASS                                                                          |
| Chaos run (services SIGKILLed)                     | PASS                                                          | PASS                                                                          |
| DLQ and replay                                     | PASS (unit)                                                   | PASS (unit; not run against a live broker)                                    |
| Every UI flow in a real browser                    | PASS, but two Pay buttons drawn, live Pay stayed after expiry | PASS, bug fixed                                                               |
| Page vs design, 1440 and 390                       | 20/20 identical                                               | 20/20 identical                                                               |
| Traces and Grafana panels                          | PASS                                                          | PASS                                                                          |
| Load test, duplicate rate 0                        | PASS                                                          | PASS (727 confirmed, 960 of 1,000 seats, 0 duplicates, 0.00% failed requests) |
| Rate limiting                                      | **missing**                                                   | PASS                                                                          |
| `/health` on services                              | **missing on 7 of 8**                                         | PASS (liveness)                                                               |
| CI on GitHub                                       | **red**                                                       | fixed, unverified until pushed                                                |
| Docker Compose, Redpanda, registry, Testcontainers | not met                                                       | not met (your earlier decision)                                               |

## Fixed (commit hashes)

- `5f66d22` Duplicate Pay / Hold buttons and the live Pay button after expiry (design's `hidden` attribute was overridden by CSS). Browser run added.
- `048ad9c` Gateway rate limiting with a Redis counter shared across instances; 429 with Retry-After; `/health` everywhere; the attack script `pnpm review:probe` (58 checks).
- `0d564b6` CI and engines to Node 22.12 (the web test tools do not run on 20). Earlier `d42e67d` (on main) fixed the install step.
- `34dfa5f` and the final commit: review documents, README failure table, trade-offs, known limitations, re-measured results.

## Still broken or risky, in order

1. **F-04 internal services trust the gateway's headers.** Anyone who can reach port 3003 can act as any user. Add a shared internal token or bind to a private network before any real deployment.
2. **CI unverified.** Push the branch and read the run. If it fails again, the log will say why (I could not read logs without a login).
3. **F-07 `next` brings `postcss` advisories** (2 high). Upgrade `next` and rerun the pixel comparison.
4. **F-06 no readiness probe.**
5. **Payment providers:** only the fake one exists; Razorpay/Stripe test-mode adapters from BUILD_PROMPT are not built.
6. Low: no LICENSE, identical page titles, 21px nav links, unstructured logs.

## Measured results

Load test (one laptop, fake provider; see README): 4,598 booking attempts in 60 s, 727 confirmed, 960 of 1,000 seats sold, 522 HTTP requests per second, p95 4 ms HTTP, 417 ms to a seat decision, 926 ms whole booking, **duplicate rate 0**. Before the review: 4,602 attempts, 733 confirmed, 829 ms whole booking: same behaviour, run-to-run variation. p99 and consumer lag were not tabulated; lag stays 0 on the dashboard.

## Decisions taken on your behalf

ADR 0018: Compose steps replaced by `pnpm stack` (no Compose file, no daemon); `[hidden]` honoured, which departs from the design files' literal rendering by two buttons; Node 22.12 minimum; nothing pushed.

## Evidence

`docs/review/evidence/` (command outputs, red-then-green test runs, probe before and after, `final/` for the last full re-run), `docs/review/screenshots/` (22 browser screenshots), `docs/images/grafana-dashboard.png`.
