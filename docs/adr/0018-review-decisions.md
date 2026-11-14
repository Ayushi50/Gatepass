# ADR 0018: Decisions taken during the unattended review

## Context

The overnight review (docs/review) had to decide a few things without the owner. Each is recorded here.

## Decisions

1. **`docker compose` steps were run as `pnpm stack` instead.** The review brief says `docker compose up -d --build`. The repository has no Compose file: Docker was dropped earlier at the owner's request and the system runs as local processes (real Kafka in KRaft mode, embedded Postgres, a Redis binary). No Docker daemon is running on this machine either. Adding Compose now would be a new feature, so the review verifies the one-command start that exists and reports the Compose / Redpanda / schema-registry / Testcontainers items of BUILD_PROMPT.md as **not met**.
2. **The `hidden` attribute is honoured, which differs from how the design files draw.** In `design/checkout.html` and `design/seats.html` the stand-in buttons carry `hidden`, and the design's script toggles it, but `.btn { display: inline-flex }` overrides the attribute, so the design draws both the live and the disabled button at all times. The app copied that faithfully: two "Pay" buttons, and a live "Pay" button after the hold expired. The design's own markup and script say only one should show, so the app now adds `[hidden] { display: none !important }`. The pixel comparison applies the same rule to the design page; everything else is still compared as drawn (20 of 20 identical). `/design` itself is unchanged. To go back to the literal rendering, delete that rule in `apps/web/src/styles/states.css`.
3. **Nothing was pushed.** The work is on the local branch `overnight-review`.

## Trade-offs

Decision 2 breaks "visually identical" in the narrow literal sense for two buttons, in exchange for a checkout that does not offer a dead Pay button. It is one CSS rule and easy to reverse.
