import { createHmac } from 'node:crypto';
import {
  InvalidSignatureError,
  ProviderRejectedError,
  ProviderUnavailableError,
  safeEqualHex,
  type ChargeRequest,
  type ChargeResult,
  type PaymentProvider,
  type ProviderWebhook,
  type RefundRequest,
  type RefundResult,
} from './provider';

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms), for the webhook age check. */
  now?: () => number;
}

/** Stripe refuses a signature older than this, so a captured webhook cannot be replayed later. */
const WEBHOOK_TOLERANCE_S = 300;

interface StripeObject {
  id?: string;
  status?: string;
  amount?: number;
  metadata?: Record<string, string>;
  last_payment_error?: { message?: string; code?: string };
}

/**
 * Stripe in TEST mode only: the constructor refuses any key that is not a test key.
 *
 * Flow: the browser turns the card into a one-time PaymentMethod id (`pm_...`) with Stripe's own
 * field, so card numbers never reach us. We create and confirm one PaymentIntent for it, with our
 * payment id as the idempotency key (a retry can never charge twice) and in `metadata` (so a
 * webhook is attributed correctly). A card that is declined is a final rejection. A charge Stripe
 * has already completed is reported as `settled`, straight from its authenticated reply, and the
 * signed webhook then confirms it again harmlessly.
 */
export class StripeTestProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: StripeOptions) {
    if (!/^(sk|rk)_test_/.test(opts.secretKey)) {
      throw new Error(
        'StripeTestProvider only accepts test keys (sk_test_...). Live keys are refused.',
      );
    }
    if (!opts.webhookSecret) throw new Error('Stripe webhook secret is required');
    this.baseUrl = opts.baseUrl ?? 'https://api.stripe.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(
    path: string,
    form: Record<string, string>,
    idempotencyKey: string,
  ): Promise<{
    status: number;
    body: StripeObject & { error?: { code?: string; message?: string } };
  }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': idempotencyKey,
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new ProviderUnavailableError(`stripe unreachable: ${(err as Error).message}`);
    }
    if (res.status >= 500 || res.status === 429) {
      throw new ProviderUnavailableError(`stripe error ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as never;
    return { status: res.status, body };
  }

  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    if (req.method !== 'card') throw new ProviderRejectedError('stripe takes card payments only');
    const { status, body } = await this.post(
      '/v1/payment_intents',
      {
        amount: String(req.amountMinor),
        currency: req.currency.toLowerCase(),
        payment_method: req.token,
        confirm: 'true',
        'automatic_payment_methods[enabled]': 'true',
        'automatic_payment_methods[allow_redirects]': 'never',
        'metadata[paymentId]': req.paymentId,
        'metadata[bookingId]': req.bookingId,
      },
      req.idempotencyKey,
    );
    if (status >= 400) {
      throw new ProviderRejectedError(
        body.error?.code ?? body.error?.message ?? `stripe ${status}`,
      );
    }
    if (!body.id) throw new ProviderUnavailableError('stripe returned no payment id');
    if (body.status === 'succeeded') return { providerRef: body.id, settled: 'succeeded' };
    if (body.status === 'processing') return { providerRef: body.id };
    // needs a further step we cannot show (3-D Secure, redirect): final, so the buyer can retry
    throw new ProviderRejectedError(`payment_${body.status ?? 'incomplete'}`);
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    const { status, body } = await this.post(
      '/v1/refunds',
      {
        payment_intent: req.providerPaymentId,
        amount: String(req.amountMinor),
        'metadata[refundId]': req.refundId,
        'metadata[paymentId]': req.paymentId,
      },
      req.refundId,
    );
    if (status >= 400) throw new ProviderRejectedError(`stripe rejected the refund (${status})`);
    if (!body.id) throw new ProviderUnavailableError('stripe returned no refund id');
    return {
      providerRefundRef: body.id,
      status: body.status === 'succeeded' ? 'completed' : 'pending',
    };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): ProviderWebhook | null {
    const header = headers['stripe-signature'] ?? '';
    const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
    const t = Number(parts.find(([k]) => k === 't')?.[1]);
    const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
    const now = (this.opts.now ?? Date.now)();
    if (!Number.isFinite(t) || signatures.length === 0)
      throw new InvalidSignatureError('bad webhook signature');
    if (Math.abs(now / 1000 - t) > WEBHOOK_TOLERANCE_S)
      throw new InvalidSignatureError('webhook signature too old');
    const expected = createHmac('sha256', this.opts.webhookSecret)
      .update(`${t}.`)
      .update(rawBody)
      .digest('hex');
    if (!signatures.some((s) => safeEqualHex(s, expected)))
      throw new InvalidSignatureError('bad webhook signature');

    let event: { id?: string; type?: string; data?: { object?: StripeObject } };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidSignatureError('unparseable webhook body');
    }
    const obj = event.data?.object ?? {};

    if (event.type === 'refund.updated' || event.type === 'charge.refund.updated') {
      if (obj.status !== 'succeeded') return null;
      const refundId = obj.metadata?.refundId;
      if (!refundId || !event.id)
        throw new InvalidSignatureError('refund webhook missing refundId');
      return { kind: 'refund', providerEventId: event.id, refundId, providerRefundRef: obj.id };
    }

    const outcome =
      event.type === 'payment_intent.succeeded'
        ? 'succeeded'
        : event.type === 'payment_intent.payment_failed'
          ? 'failed'
          : null;
    if (!outcome) return null;
    const paymentId = obj.metadata?.paymentId;
    if (!paymentId || !event.id) throw new InvalidSignatureError('webhook missing paymentId');
    return {
      kind: 'payment',
      providerEventId: event.id,
      paymentId,
      outcome,
      providerRef: obj.id,
      providerPaymentId: obj.id,
      reason:
        outcome === 'failed' ? (obj.last_payment_error?.message ?? 'payment_failed') : undefined,
      amountMinor: obj.amount,
    };
  }
}
