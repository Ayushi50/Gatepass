# Gatepass UI: "House lights"

Plain HTML, CSS and vanilla JS. No build step, no framework. Open any page in a browser.
These files are the **visual source of truth** for the Gatepass frontend.

## Design rules (do not drift)

- Tokens live in `assets/gatepass.css` (`:root`). Never hard-code a color or font in a page.
- Display font Bodoni Moda (500 and italic 500). UI font Inter (400/500/600).
- Dark theatre ground, one accent: amber `#FFB347`. Danger is rose `#FF8A97`. Tickets are cream.
- Pill buttons (999px radius). Minimum touch target 44px.
- Seat state is never color alone: available = ring, selected = amber fill + check, held = dashed amber outline, taken = filled + x.
- Keyboard reachable, visible focus ring, `prefers-reduced-motion` respected, WCAG AA contrast.

## Pages and the backend they need

| Page | What it shows | Backend contract |
|---|---|---|
| `index.html` | Landing | none |
| `events.html` | Show list with category filter | `GET /api/events` |
| `seats.html` | Seat map, selection (max 6), stub total | `GET /api/events/:id/seats`, SSE `/api/events/:id/seats/stream`, `POST /api/bookings {eventId, seatIds}` |
| `checkout.html` | Hold countdown, payment method, pay | `GET /api/bookings/:id` (use `holdExpiresAt`), `POST /api/bookings/:id/pay` with `Idempotency-Key` |
| `status.html` | Three lights: seats held, payment received, ticket issued | SSE `/api/bookings/:id/stream` |
| `tickets.html` | Cream tickets with QR | `GET /api/tickets`, `POST /api/tickets/:id/refund` |
| `organizer.html` | Sales tiles, tier bars, refunds, live feed | `GET /api/organizer/events/:id/summary`, `POST /api/refunds/:id/approve`, SSE `/api/organizer/events/:id/activity` |
| `check-in.html` | Phone door scanner | `POST /api/checkin {qrToken}` |

Each page has a `// BACKEND:` comment at the top of its script showing exactly what to replace with real calls.
The sample data (arrays at the top of each script) is placeholder only.

## Kafka and the browser

The browser never talks to Kafka. It uses REST plus SSE through the gateway.
Kafka (Redpanda in dev) connects backend services; the gateway bridges selected events to SSE:

- `seats.held`, `seats.sold`, `seats.released`, `hold.expired` -> seat map updates
- `payment.succeeded`, `payment.failed`, `ticket.issued`, `booking.confirmed` -> status page lights
- all of the above -> organizer activity feed

## Preview-only controls

The pill switchers on `status.html` and `check-in.html` (In progress / Confirmed / Payment failed, Ready / Valid / Used) exist for design review.
In the real app, remove them and drive the mode from backend data.
