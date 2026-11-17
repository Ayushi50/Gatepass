import { createHmac } from 'node:crypto';
import {
  InvalidSignatureError,
  ProviderRejectedError,
  ProviderUnavailableError,
  StripeTestProvider,
  type ChargeRequest,
} from '../src';

const SECRET = 'whsec_test_secret';
const NOW = 1_800_000_000_000;

const charge = (over: Partial<ChargeRequest> = {}): ChargeRequest => ({
  paymentId: 'pay_000001',
  bookingId: 'bk-1',
  amountMinor: 360000,
  currency: 'INR',
  method: 'card',
  token: 'pm_card_visa',
  idempotencyKey: 'pay_000001',
  ...over,
});

interface Call {
  url: string;
  init: RequestInit;
  form: URLSearchParams;
}
function stripeApi(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url, init, form: new URLSearchParams(String(init.body ?? '')) };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const make = (fetchImpl?: typeof fetch, key = 'sk_test_abc') =>
  new StripeTestProvider({ secretKey: key, webhookSecret: SECRET, fetchImpl, now: () => NOW });

/** What Stripe puts in the `Stripe-Signature` header. */
function signed(body: string, opts: { t?: number; secret?: string } = {}) {
  const t = opts.t ?? Math.floor(NOW / 1000);
  const v1 = createHmac('sha256', opts.secret ?? SECRET)
    .update(`${t}.${body}`)
    .digest('hex');
  return { 'stripe-signature': `t=${t},v1=${v1}` };
}
const event = (type: string, object: Record<string, unknown>, id = 'evt_1') =>
  JSON.stringify({ id, type, data: { object } });

describe('StripeTestProvider', () => {
  it('refuses live keys', () => {
    expect(() => make(undefined, 'sk_live_abc')).toThrow(/test keys/);
    expect(() => make(undefined, 'rk_live_abc')).toThrow(/test keys/);
    expect(() => make(undefined, 'whatever')).toThrow(/test keys/);
    expect(() => make(undefined, 'sk_test_abc')).not.toThrow();
  });

  describe('createCharge', () => {
    it('creates and confirms one PaymentIntent that carries our payment id, idempotently', async () => {
      const api = stripeApi(() => json(200, { id: 'pi_1', status: 'succeeded', amount: 360000 }));
      const out = await make(api.fetchImpl).createCharge(charge());
      const [call] = api.calls;
      expect(call!.url).toBe('https://api.stripe.com/v1/payment_intents');
      expect(call!.form.get('amount')).toBe('360000');
      expect(call!.form.get('currency')).toBe('inr');
      expect(call!.form.get('payment_method')).toBe('pm_card_visa');
      expect(call!.form.get('confirm')).toBe('true');
      expect(call!.form.get('automatic_payment_methods[allow_redirects]')).toBe('never');
      expect(call!.form.get('metadata[paymentId]')).toBe('pay_000001');
      expect(call!.form.get('metadata[bookingId]')).toBe('bk-1');
      const h = call!.init.headers as Record<string, string>;
      expect(h['idempotency-key']).toBe('pay_000001');
      expect(h.authorization).toBe('Bearer sk_test_abc');
      expect(out).toEqual({ providerRef: 'pi_1', settled: 'succeeded' });
    });

    it('does not claim success for a charge that is not finished yet', async () => {
      const api = stripeApi(() => json(200, { id: 'pi_2', status: 'processing' }));
      expect(await make(api.fetchImpl).createCharge(charge())).toEqual({ providerRef: 'pi_2' });
    });

    it('treats a declined card as a final rejection, with the reason', async () => {
      const api = stripeApi(() =>
        json(402, { error: { type: 'card_error', code: 'card_declined', message: 'declined' } }),
      );
      await expect(make(api.fetchImpl).createCharge(charge())).rejects.toThrow(
        new ProviderRejectedError('card_declined'),
      );
    });

    it('treats a payment that needs more steps (3-D Secure) as a rejection, not a hang', async () => {
      const api = stripeApi(() => json(200, { id: 'pi_3', status: 'requires_action' }));
      await expect(make(api.fetchImpl).createCharge(charge())).rejects.toBeInstanceOf(
        ProviderRejectedError,
      );
    });

    it('only does cards', async () => {
      const api = stripeApi(() => json(200, {}));
      await expect(make(api.fetchImpl).createCharge(charge({ method: 'upi' }))).rejects.toThrow(
        /card/,
      );
      expect(api.calls).toHaveLength(0);
    });

    it('maps 5xx, 429 and network errors to retryable, other 4xx to final', async () => {
      const respond = (status: number) =>
        make(stripeApi(() => json(status, { error: { message: 'x' } })).fetchImpl);
      await expect(respond(500).createCharge(charge())).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
      await expect(respond(429).createCharge(charge())).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
      await expect(respond(400).createCharge(charge())).rejects.toBeInstanceOf(
        ProviderRejectedError,
      );
      const down = make((async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch);
      await expect(down.createCharge(charge())).rejects.toBeInstanceOf(ProviderUnavailableError);
    });
  });

  describe('refund', () => {
    const req = {
      refundId: 'rf_000001',
      paymentId: 'pay_000001',
      providerPaymentId: 'pi_1',
      amountMinor: 120000,
      currency: 'INR',
    };
    it('refunds the PaymentIntent, once per refund id', async () => {
      const api = stripeApi(() => json(200, { id: 're_1', status: 'succeeded' }));
      const out = await make(api.fetchImpl).refund(req);
      const [call] = api.calls;
      expect(call!.url).toBe('https://api.stripe.com/v1/refunds');
      expect(call!.form.get('payment_intent')).toBe('pi_1');
      expect(call!.form.get('amount')).toBe('120000');
      expect(call!.form.get('metadata[refundId]')).toBe('rf_000001');
      expect((call!.init.headers as Record<string, string>)['idempotency-key']).toBe('rf_000001');
      expect(out).toEqual({ providerRefundRef: 're_1', status: 'completed' });
    });
    it('reports a pending refund as pending, and maps errors', async () => {
      const pending = stripeApi(() => json(200, { id: 're_2', status: 'pending' }));
      expect((await make(pending.fetchImpl).refund(req)).status).toBe('pending');
      const bad = make(stripeApi(() => json(400, { error: { message: 'x' } })).fetchImpl);
      await expect(bad.refund(req)).rejects.toBeInstanceOf(ProviderRejectedError);
      const busy = make(stripeApi(() => json(503, {})).fetchImpl);
      await expect(busy.refund(req)).rejects.toBeInstanceOf(ProviderUnavailableError);
    });
  });

  describe('verifyWebhook', () => {
    const intent = (over = {}) => ({
      id: 'pi_1',
      amount: 360000,
      metadata: { paymentId: 'pay_000001' },
      ...over,
    });
    const verify = (body: string, headers: Record<string, string | undefined>) =>
      make().verifyWebhook(Buffer.from(body), headers);

    it('turns a succeeded PaymentIntent into a payment success', () => {
      const body = event('payment_intent.succeeded', intent(), 'evt_9');
      expect(verify(body, signed(body))).toEqual({
        kind: 'payment',
        providerEventId: 'evt_9',
        paymentId: 'pay_000001',
        outcome: 'succeeded',
        providerRef: 'pi_1',
        providerPaymentId: 'pi_1',
        reason: undefined,
        amountMinor: 360000,
      });
    });

    it('turns a failed PaymentIntent into a payment failure with its reason', () => {
      const body = event(
        'payment_intent.payment_failed',
        intent({ last_payment_error: { message: 'Your card was declined.' } }),
      );
      expect(verify(body, signed(body))).toMatchObject({
        outcome: 'failed',
        reason: 'Your card was declined.',
      });
    });

    it('turns a finished refund into a refund webhook, and ignores unfinished ones', () => {
      const done = event(
        'refund.updated',
        { id: 're_1', status: 'succeeded', metadata: { refundId: 'rf_000001' } },
        'evt_r',
      );
      expect(verify(done, signed(done))).toEqual({
        kind: 'refund',
        providerEventId: 'evt_r',
        refundId: 'rf_000001',
        providerRefundRef: 're_1',
      });
      const pending = event('refund.updated', {
        id: 're_1',
        status: 'pending',
        metadata: { refundId: 'rf_000001' },
      });
      expect(verify(pending, signed(pending))).toBeNull();
    });

    it('ignores authentic events it does not care about', () => {
      const body = event('customer.created', { id: 'cus_1' });
      expect(verify(body, signed(body))).toBeNull();
    });

    it('rejects a missing, forged, tampered or stale signature', () => {
      const body = event('payment_intent.succeeded', intent());
      const stale = signed(body, { t: Math.floor(NOW / 1000) - 600 });
      const cases: Record<string, string | undefined>[] = [
        {},
        { 'stripe-signature': 'garbage' },
        signed(body, { secret: 'whsec_other' }),
        stale,
      ];
      for (const h of cases) expect(() => verify(body, h)).toThrow(InvalidSignatureError);
      expect(() => verify(body + ' ', signed(body))).toThrow(InvalidSignatureError);
    });

    it('accepts any one of several v1 signatures (Stripe sends two while a secret rotates)', () => {
      const body = event('payment_intent.succeeded', intent());
      const t = Math.floor(NOW / 1000);
      const good = signed(body)['stripe-signature'].split('v1=')[1];
      expect(
        verify(body, { 'stripe-signature': `t=${t},v1=${'0'.repeat(64)},v1=${good}` }),
      ).not.toBeNull();
    });

    it('rejects an authentic payment event that does not name our payment', () => {
      const body = event('payment_intent.succeeded', { id: 'pi_x', amount: 1, metadata: {} });
      expect(() => verify(body, signed(body))).toThrow(InvalidSignatureError);
    });
  });
});
