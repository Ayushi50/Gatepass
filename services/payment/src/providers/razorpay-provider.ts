import {
  InvalidSignatureError,
  ProviderRejectedError,
  ProviderUnavailableError,
  hmacHex,
  safeEqualHex,
  type ChargeRequest,
  type ChargeResult,
  type PaymentProvider,
  type ProviderWebhook,
} from './provider';

export interface RazorpayOptions {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        error_description?: string;
        notes?: Record<string, string> | unknown[];
      };
    };
  };
}

/**
 * Razorpay in TEST mode only. The constructor refuses any key that is not a test key, so a live
 * key can never be configured by mistake.
 *
 * Flow: we create an Order (one per payment, carrying our payment id in `notes`); the customer
 * pays in Razorpay's own checkout (UPI, card, netbanking); Razorpay then calls our webhook.
 * Matching uses `notes.paymentId`, so a webhook is attributed correctly even if it arrives
 * before we have stored the order id.
 *
 * Note: Razorpay's order API has no idempotency key. We create at most one order per payment
 * row; if a create call times out and is retried, an unpaid duplicate order can exist. No money
 * moves until a customer pays an order, and the webhook still carries our payment id.
 */
export class RazorpayTestProvider implements PaymentProvider {
  readonly name = 'razorpay';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RazorpayOptions) {
    if (!opts.keyId.startsWith('rzp_test_')) {
      throw new Error(
        'RazorpayTestProvider only accepts test keys (rzp_test_...). Live keys are refused.',
      );
    }
    if (!opts.keySecret || !opts.webhookSecret) throw new Error('Razorpay secrets are required');
    this.baseUrl = opts.baseUrl ?? 'https://api.razorpay.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/orders`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${this.opts.keyId}:${this.opts.keySecret}`).toString('base64')}`,
        },
        body: JSON.stringify({
          amount: req.amountMinor,
          currency: req.currency,
          receipt: req.paymentId,
          notes: { paymentId: req.paymentId, bookingId: req.bookingId, method: req.method },
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      throw new ProviderUnavailableError(`razorpay unreachable: ${(err as Error).message}`);
    }
    if (res.status >= 500 || res.status === 429) {
      throw new ProviderUnavailableError(`razorpay error ${res.status}`);
    }
    if (!res.ok) throw new ProviderRejectedError(`razorpay rejected the order (${res.status})`);
    const order = (await res.json()) as { id?: string };
    if (!order.id) throw new ProviderUnavailableError('razorpay returned no order id');
    return { providerRef: order.id };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): ProviderWebhook | null {
    const given = headers['x-razorpay-signature'];
    if (!given || !safeEqualHex(given, hmacHex(this.opts.webhookSecret, rawBody))) {
      throw new InvalidSignatureError('bad webhook signature');
    }
    let body: RazorpayWebhookBody;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidSignatureError('unparseable webhook body');
    }
    const outcome =
      body.event === 'payment.captured' || body.event === 'order.paid'
        ? 'succeeded'
        : body.event === 'payment.failed'
          ? 'failed'
          : null;
    if (!outcome) return null;

    const entity = body.payload?.payment?.entity;
    const notes = entity?.notes && !Array.isArray(entity.notes) ? entity.notes : {};
    const paymentId = notes.paymentId;
    const eventId = headers['x-razorpay-event-id'];
    if (!paymentId || !eventId) {
      throw new InvalidSignatureError('webhook missing paymentId note or event id');
    }
    return {
      providerEventId: eventId,
      paymentId,
      outcome,
      providerRef: entity?.order_id ?? entity?.id,
      reason: outcome === 'failed' ? (entity?.error_description ?? 'payment_failed') : undefined,
      amountMinor: entity?.amount,
    };
  }
}
