import {
  InvalidSignatureError,
  ProviderRejectedError,
  hmacHex,
  safeEqualHex,
  type ChargeRequest,
  type ChargeResult,
  type PaymentProvider,
  type ProviderWebhook,
} from './provider';

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

/**
 * Tokens choose the outcome, like a provider's test cards:
 *   tok_success   charge accepted, webhook says succeeded   (default behaviour)
 *   tok_declined  charge accepted, webhook says failed
 *   tok_rejected  refused immediately when the charge is created
 */
export const FAKE_TOKENS = {
  success: 'tok_success',
  declined: 'tok_declined',
  rejected: 'tok_rejected',
};

export interface FakeProviderOptions {
  webhookSecret: string;
  /** Dev convenience: deliver the signed webhook by itself after a delay. Never used in tests. */
  autoWebhook?: {
    delayMs: number;
    deliver: (body: string, headers: Record<string, string>) => Promise<void>;
  };
}

interface FakeCharge {
  providerRef: string;
  request: ChargeRequest;
}

/**
 * A deterministic stand-in for a real provider. It records every call, is idempotent per
 * idempotency key like a real provider, and can produce correctly signed webhooks, so tests
 * drive the same signature-checking code path production uses.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake';
  /** Number of createCharge calls, including repeats. */
  calls = 0;
  /** Distinct charges actually created (by idempotency key): money-moving events. */
  readonly charges = new Map<string, FakeCharge>();
  /** When set, createCharge throws this (simulates a timeout or outage). */
  failWith: Error | undefined;
  private eventCounter = 0;

  constructor(private readonly opts: FakeProviderOptions) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FakeProvider must never be used in production');
    }
  }

  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    if (req.token === FAKE_TOKENS.rejected) throw new ProviderRejectedError('card_rejected');
    let charge = this.charges.get(req.idempotencyKey);
    if (!charge) {
      charge = {
        providerRef: `fake_ch_${this.charges.size + 1}_${req.paymentId.slice(-6)}`,
        request: req,
      };
      this.charges.set(req.idempotencyKey, charge);
      const auto = this.opts.autoWebhook;
      if (auto) {
        const hook = this.buildWebhook(req.paymentId, FakeProvider.outcomeFor(req.token));
        setTimeout(
          () => void auto.deliver(hook.body, hook.headers).catch(() => {}),
          auto.delayMs,
        ).unref();
      }
    }
    return { providerRef: charge.providerRef };
  }

  static outcomeFor(token: string): 'succeeded' | 'failed' {
    return token === FAKE_TOKENS.declined ? 'failed' : 'succeeded';
  }

  /** A signed webhook for a payment, as the real provider would deliver it. */
  buildWebhook(
    paymentId: string,
    outcome: 'succeeded' | 'failed',
    opts: { eventId?: string; amountMinor?: number; reason?: string } = {},
  ): { body: string; headers: Record<string, string> } {
    const charge = [...this.charges.values()].find((c) => c.request.paymentId === paymentId);
    const body = JSON.stringify({
      id: opts.eventId ?? `evt_${++this.eventCounter}_${paymentId.slice(-6)}`,
      type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
      paymentId,
      providerRef: charge?.providerRef,
      amountMinor: opts.amountMinor ?? charge?.request.amountMinor,
      reason: outcome === 'failed' ? (opts.reason ?? 'declined') : undefined,
    });
    return { body, headers: { [FAKE_SIGNATURE_HEADER]: hmacHex(this.opts.webhookSecret, body) } };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): ProviderWebhook | null {
    const given = headers[FAKE_SIGNATURE_HEADER];
    if (!given || !safeEqualHex(given, hmacHex(this.opts.webhookSecret, rawBody))) {
      throw new InvalidSignatureError('bad webhook signature');
    }
    let ev: {
      id?: string;
      type?: string;
      paymentId?: string;
      providerRef?: string;
      amountMinor?: number;
      reason?: string;
    };
    try {
      ev = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidSignatureError('unparseable webhook body');
    }
    if (ev.type !== 'payment.succeeded' && ev.type !== 'payment.failed') return null;
    if (!ev.id || !ev.paymentId) throw new InvalidSignatureError('webhook missing id or paymentId');
    return {
      providerEventId: ev.id,
      paymentId: ev.paymentId,
      outcome: ev.type === 'payment.succeeded' ? 'succeeded' : 'failed',
      providerRef: ev.providerRef,
      reason: ev.reason,
      amountMinor: ev.amountMinor,
    };
  }
}
