# Deployment checklist (Ubuntu 24.04, demo grade, Razorpay TEST mode)

Run everything from the repo checkout on the server (clone it to `/opt/gatepass`). `deploy/scripts/*` need `sudo`.

## A. Before you start
- [ ] VPS: Ubuntu 24.04, 4 GB RAM or more, SSH works.
- [ ] Domain A record points at the VPS (`dig +short <domain>` shows its IP).
- [ ] Cloud firewall (provider panel, if any) allows 22, 80, 443.
- [ ] Google OAuth client (type Web application) with redirect URI `https://<domain>/api/auth/google/callback`.
- [ ] Razorpay Dashboard in **Test Mode**: test Key Id and Key Secret; Payment Capture set to Automatic.

## B. Install, in order
- [ ] `sudo deploy/scripts/01-install.sh`
- [ ] `deploy/scripts/02-secrets.sh`
- [ ] `sudo deploy/scripts/03-databases.sh`
- [ ] `deploy/scripts/04-topics.sh`
- [ ] `cp deploy/.env.production.example deploy/.env.production`, fill the YOU FILL section; make the webhook secret with `openssl rand -hex 32`
- [ ] `sudo deploy/scripts/05-render-env.sh`
- [ ] `sudo deploy/scripts/06-build.sh`
- [ ] `sudo deploy/scripts/07-services.sh`
- [ ] `sudo deploy/scripts/08-seed.sh` (optional: the five demo shows)
- [ ] `sudo deploy/scripts/09-caddy.sh`
- [ ] `sudo deploy/scripts/10-firewall.sh`
- [ ] Razorpay Dashboard webhook added (see `deploy/RAZORPAY.md`): URL `https://<domain>/webhooks/razorpay`

## C. Automated: `sudo deploy/scripts/11-smoke-test.sh`
It checks: all 9 processes + Postgres, Redis, Redpanda, Caddy are active; every `/health`; the gateway reaching
catalog, seat-inventory, payment, booking, ticket and analytics; all 17 event topics and 6 dead-letter topics exist;
the demo sign-in is off; webhook valid signature accepted, bad or missing signature rejected, the fake provider's
webhook route not served; a booking held, paid (signed webhook), duplicate webhook ignored, booking confirmed,
ticket issued with a QR token.

Side effects: it sells one seat of a demo show and leaves one unpaid Razorpay **test** order.

## D. Manual: the smoke test CANNOT prove these
- [ ] **Ports closed from outside.** From your laptop: `nc -zv <server-ip> 3000`, `3004`, `3100`, `5432`, `6379`, `9092` must all time out; 80 and 443 must connect.
- [ ] **HTTPS.** `https://<domain>` loads with a valid certificate; `http://<domain>` redirects to https.
- [ ] **Google sign-in.** Sign in with a Google account; an `ORGANIZER_EMAILS` account sees the organizer dashboard; a stranger is an attendee.
- [ ] **A real payment.** In the browser, hold seats and pay with UPI `success@razorpay`. Booking reaches "confirmed" and a ticket with a QR appears.
- [ ] **Real webhook delivery.** Razorpay Dashboard → Webhooks → your webhook → delivery log shows 200 for `payment.captured`/`order.paid`. (If it shows failures, check Payment Capture and the URL.)
- [ ] **Failure path.** Pay with `failure@razorpay`: the booking is cancelled and the seats come back.
- [ ] **Door scan.** Sign in as a `DOOR_STAFF_EMAILS` account, scan the ticket: "valid", then a second scan: "used".
- [ ] **Live seat map.** Open one show in two browsers; a hold in one shows in the other without a refresh (checks that Caddy streams SSE).
- [ ] **Restart survives.** `sudo systemctl restart gatepass@booking`, then `sudo reboot`: after boot all 9 processes are active again without help.
- [ ] **Rate limits.** Several people signing in from different networks should not hit "too many requests" (they share one address at the gateway; limits are raised in `.env.production`).

## E. If something fails
- Logs: `journalctl -u gatepass@<name> -n 100 --no-pager` (names: catalog, seat-inventory, booking, payment, ticket, notification, analytics, gateway, web).
- Caddy: `journalctl -u caddy -n 50`, access log `/var/log/caddy/gatepass-access.log`.
- Redpanda: `rpk cluster health`, `journalctl -u redpanda -n 50`.
- Memory: `free -m` and `systemctl status`; if processes are being killed (OOM), raise server RAM or lower `NODE_HEAP_MB`.
- A service that exits at boot because Kafka or Postgres was not ready is restarted every 3 seconds by systemd, so wait a minute before digging.

## F. Updating later
`git pull`, then `sudo deploy/scripts/06-build.sh` and `sudo deploy/scripts/07-services.sh`. Migrations run on service start.
