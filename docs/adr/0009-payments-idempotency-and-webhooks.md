# ADR 0009: Payments - provider interface, idempotent pay, signed and de-duplicated webhooks

## Context

Rule 2 and 7: payment calls use idempotency keys; webhooks verify signatures and tolerate duplicate, late and out-of-order delivery. Test mode only.

## Decision

**Provider boundary.** `PaymentProvider` has `createCharge` and `verifyWebhook`. `FakeProvider` (tests, local dev) is deterministic, idempotent per key, records every call and produces correctly signed webhooks, so tests exercise the real signature code. `RazorpayTestProvider` refuses any key that is not `rzp_test_...`. The pay request carries only a method and an opaque provider token, never raw card data. Refunds are not in the interface yet (Phase 4).

**Amount comes from the event stream.** Seat-inventory puts `amount_minor` and `currency` in `seats.held`; payment stores a `payable` from it. Payment never calls booking, and the client cannot choose the amount.

**One charge per booking, enforced three ways.**

1. `Idempotency-Key`: `UNIQUE (booking_id, idempotency_key)`. Same key and same request replays the stored payment; same key with a different request (fingerprint) is 422.
2. A partial unique index allows only one non-`FAILED` payment per booking, so a second key while one is live is 409, even under a race.
3. The provider is called with the payment id as its idempotency key, and the payment row is committed before the call, so a crash or timeout leaves a `CREATED` row that a retry with the same key resumes. Nothing can create a second charge.

**Webhooks.** The signature is HMAC-SHA256 over the raw body, compared in constant time; a bad signature is 400 and stores nothing. Each accepted delivery is recorded once by `(provider, provider_event_id)`; a duplicate is acknowledged with 200 and does nothing (also under concurrency, because the insert conflict serialises them). The payment is matched by our id in the provider's metadata, so an early webhook still finds it. A payment's `SUCCEEDED` / `FAILED` state is final: a later contradicting webhook is stored with result `conflict` and not applied. A reported amount that differs from ours is stored as `amount_mismatch` and not applied. `payment.succeeded` / `payment.failed` are written to the outbox in the same transaction as the state change.

## Trade-offs

- A `failed` webhook is final even though a real provider can let a customer retry the same order. We cancel the booking and release seats on the first failure; a later success is recorded as a `conflict` and needs a refund, which Phase 4 handles.
- Razorpay's order API has no idempotency key, so a create call retried after a timeout can leave an unpaid duplicate order. No money moves until someone pays an order, and webhooks still carry our payment id.
- The Razorpay provider is covered by signature vectors and a mocked HTTP client, not by calls to Razorpay.
- `payment.succeeded` for a booking whose seats are no longer held makes seat-inventory throw, so it is retried and dead-lettered visibly. Nothing expires holds yet, so this cannot occur until Phase 4, which decides between auto-refund and honoring the payment.
