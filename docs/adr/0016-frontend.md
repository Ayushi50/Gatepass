# ADR 0016: The web app is the design, ported; proven identical by pixels

## Context

`design/` holds eight finished HTML pages ("House lights") that define the look exactly. The frontend must be built from them without restyling, and must work against the real gateway.

## Decision

- **Next.js (App Router), one client component per page.** `design/assets/gatepass.css` is copied byte for byte. Each page's own `<style>` block is lifted by `apps/web/scripts/scope-css.mjs` into a stylesheet with every selector prefixed by that page's root class, so one route's styles cannot leak into another on client-side navigation. Markup, copy and class names are the design's.
- **Proven, not claimed.** `pnpm --filter @gatepass/web visual` loads each design page (with its own sample data) and the matching Next page (fed the same data by intercepted API calls), with the clock frozen, animations off and web fonts blocked so both use the same fallback font, and compares full-page screenshots pixel by pixel at desktop and phone widths. 20 of 20 comparisons are identical (0 differing pixels). Deliberately excluded: the QR image (the design draws a placeholder pattern), the camera viewfinder, the "already used" scanner state (the design's copy names a gate the backend does not record), and the gate label (real show title vs. the design's hand-shortened one, equalised in the test).
- **Same origin.** Next rewrites `/api/*` to the gateway, so there is no CORS and the browser only ever talks to one origin. Compression is off so event streams are not buffered.
- **Streams use `fetch`, not `EventSource`**, so the `Authorization` header can be sent and no token ever appears in a URL. `openStream` reconnects with backoff; the seat map re-reads itself after a reconnect so nothing is missed.
- **The hold clock follows the server.** Checkout measures `serverTime - Date.now()` when the booking is read and counts down to `holdExpiresAt` with that skew applied (tested with browsers 5 minutes fast and slow).
- **Idempotent paying.** One `Idempotency-Key` per booking is kept for the tab, so a double click or retry cannot charge twice.
- **Cards (a conflict with the design, kept as designed).** The design has card number fields. They stay, but in test mode they only choose a test token for the fake provider (`4000 0000 0000 0002` declines); the number, UPI id and CVC are never sent anywhere. A real provider's own hosted checkout would replace this.
- **Demo sign-in.** There are no real accounts, so the gateway has an off-by-default `POST /api/dev-login` (needs `ENABLE_DEV_LOGIN=true`, never in production) that mints a demo token. The token is kept in `localStorage`: fine for a demo, not for production.
- **Added states** the design implies but does not draw: loading, empty, error, "hold expired", a payment-failed variant for a cancelled booking, and the waiting-room page. They use only existing tokens.

## Where the design and the system disagree (design kept)

- Status page "Try paying again" leads to a closed booking, because a failed payment cancels the booking and releases the seats. The checkout page then explains this and links to pick new seats.
- Door scanner: "scanned at 7:12 PM" without a gate name. A typed-code box takes the slot of the design-review switcher, for devices without a camera.
- QR codes are large (a signed token), so each ticket's QR can be tapped to enlarge.
- The organizer page has no list of an organizer's shows; it opens `?event=<id>` (default `neon-nights`).

## Trade-offs

- Camera scanning uses the browser's `BarcodeDetector` with a `jsQR` fallback; it is not exercised by the automated tests (a fake camera cannot show a ticket), only the typed-code path is.
- The browser tests need a real Kafka (`KAFKA_HOME`), so they are a separate command (`pnpm e2e`), not part of `pnpm test`.
