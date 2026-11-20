# Razorpay (TEST mode) webhook setup

Gatepass only ever talks to Razorpay in **Test Mode**. `services/payment/src/providers/razorpay-provider.ts`
refuses any key that does not start with `rzp_test_`, the gateway refuses it at boot, and
`deploy/scripts/05-render-env.sh` refuses it before anything is written. None of these guards were changed.

## How the keys reach the code
You put three values in `deploy/.env.production` (never in git, never in chat):

| Variable | Where it comes from | Used by |
|---|---|---|
| `RAZORPAY_KEY_ID` | Dashboard → API Keys (Test Mode), starts `rzp_test_` | payment, gateway |
| `RAZORPAY_KEY_SECRET` | shown once when you generate the test key | payment |
| `RAZORPAY_WEBHOOK_SECRET` | you generate it (below); the SAME value goes in the Dashboard | payment |

`sudo deploy/scripts/05-render-env.sh` copies them into `/etc/gatepass/payment.env` (and the key id into
`gateway.env`), then `sudo deploy/scripts/07-services.sh` restarts the services.

## Steps in the Razorpay Dashboard
1. Switch the Dashboard to **Test Mode** (toggle at the top). Confirm the banner says Test Mode.
2. **API Keys** (Account & Settings → API Keys): generate a test key. Copy the Key Id and Key Secret into
   `deploy/.env.production`.
3. On the server (or your laptop), generate the webhook secret:
   ```bash
   openssl rand -hex 32
   ```
   Paste the output into `RAZORPAY_WEBHOOK_SECRET=` in `deploy/.env.production`.
4. **Webhooks** (Account & Settings → Webhooks; newer dashboards list it under Developer Controls) → **Add New Webhook**:
   - **Webhook URL:** `https://<your-domain>/webhooks/razorpay`
   - **Secret:** the same `openssl rand -hex 32` value from step 3
   - **Active Events**, tick exactly these four:
     - `payment.captured`
     - `payment.failed`
     - `order.paid`
     - `refund.processed`
   - Alert email: optional. Save.
5. Re-run `05-render-env.sh` and `07-services.sh` if you edited `.env.production` after the services started.

## Check it before relying on it
- **Auto-capture:** `payment.captured` and `order.paid` only fire once a payment is captured. Gatepass creates orders
  without asking for manual capture, so the account's Payment Capture setting (Settings → Payment Capture) should be
  **Automatic**. If it is Manual, successful test payments will stay "authorized" and the webhook will not fire. This is
  a Dashboard setting I cannot see from the code, so please confirm it.
- **What each event does** (from `verifyWebhook`): `payment.captured` and `order.paid` mark the payment succeeded,
  `payment.failed` marks it failed (seats are released), `refund.processed` completes a refund. Any other event is
  acknowledged with 200 and ignored. A wrong or missing signature returns 400 and changes nothing.
- **Duplicates and late delivery** are tolerated: Razorpay sends an event id header, and the payment service de-duplicates on it.
- **Second route:** when the buyer finishes in Razorpay's window, the browser also confirms the payment through the
  gateway (`/api/bookings/:id/pay/confirm`, verified with the key secret). So the webhook is the backup path, not the
  only one.

## Pay with test credentials
UPI: `success@razorpay` (success) or `failure@razorpay` (failure). Or one of Razorpay's published test cards.
No real money moves in Test Mode.

## Rotating the webhook secret
Generate a new value, update it in both places (`.env.production` and the Dashboard webhook), re-run
`05-render-env.sh` and `systemctl restart gatepass@payment`. Deliveries in between will be rejected with 400, and
Razorpay retries them.
