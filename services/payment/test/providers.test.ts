import {
  FAKE_SIGNATURE_HEADER,
  FAKE_TOKENS,
  FakeProvider,
  InvalidSignatureError,
  ProviderRejectedError,
  ProviderUnavailableError,
  RazorpayTestProvider,
  canTransition,
  hmacHex,
  isFinal,
  type ChargeRequest,
} from '../src';

const charge = (over: Partial<ChargeRequest> = {}): ChargeRequest => ({
  paymentId: 'pay_000001',
  bookingId: 'bk-1',
  amountMinor: 360000,
  currency: 'INR',
  method: 'upi',
  token: FAKE_TOKENS.success,
  idempotencyKey: 'pay_000001',
  ...over,
});

describe('payment state machine', () => {
  it('only moves forward and never leaves a final state', () => {
    expect(canTransition('CREATED', 'PROCESSING')).toBe(true);
    expect(canTransition('PROCESSING', 'SUCCEEDED')).toBe(true);
    expect(canTransition('PROCESSING', 'FAILED')).toBe(true);
    expect(canTransition('SUCCEEDED', 'FAILED')).toBe(false);
    expect(canTransition('FAILED', 'SUCCEEDED')).toBe(false);
    expect(canTransition('PROCESSING', 'CREATED')).toBe(false);
    expect(isFinal('SUCCEEDED')).toBe(true);
    expect(isFinal('FAILED')).toBe(true);
    expect(isFinal('PROCESSING')).toBe(false);
  });
});

describe('FakeProvider', () => {
  const secret = 'whsec_fake_test_secret';
  let provider: FakeProvider;
  beforeEach(() => {
    provider = new FakeProvider({ webhookSecret: secret });
  });

  it('creates one charge per idempotency key, however often it is called', async () => {
    const a = await provider.createCharge(charge());
    const b = await provider.createCharge(charge());
    expect(a.providerRef).toBe(b.providerRef);
    expect(provider.calls).toBe(2);
    expect(provider.charges.size).toBe(1);
    await provider.createCharge(charge({ paymentId: 'pay_000002', idempotencyKey: 'pay_000002' }));
    expect(provider.charges.size).toBe(2);
  });

  it('rejects immediately for the rejected token and can simulate an outage', async () => {
    await expect(
      provider.createCharge(charge({ token: FAKE_TOKENS.rejected })),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
    provider.failWith = new ProviderUnavailableError('timeout');
    await expect(provider.createCharge(charge())).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(provider.charges.size).toBe(0);
  });

  it('produces webhooks that verify, and parses them', async () => {
    await provider.createCharge(charge());
    const hook = provider.buildWebhook('pay_000001', 'succeeded', { eventId: 'evt_a' });
    const parsed = provider.verifyWebhook(Buffer.from(hook.body), hook.headers);
    expect(parsed).toMatchObject({
      providerEventId: 'evt_a',
      paymentId: 'pay_000001',
      outcome: 'succeeded',
      amountMinor: 360000,
    });
    const failed = provider.buildWebhook('pay_000001', 'failed', { reason: 'insufficient_funds' });
    expect(provider.verifyWebhook(Buffer.from(failed.body), failed.headers)).toMatchObject({
      outcome: 'failed',
      reason: 'insufficient_funds',
    });
  });

  it('rejects a missing, wrong or tampered signature', async () => {
    await provider.createCharge(charge());
    const hook = provider.buildWebhook('pay_000001', 'succeeded');
    expect(() => provider.verifyWebhook(Buffer.from(hook.body), {})).toThrow(InvalidSignatureError);
    expect(() =>
      provider.verifyWebhook(Buffer.from(hook.body), { [FAKE_SIGNATURE_HEADER]: 'deadbeef' }),
    ).toThrow(InvalidSignatureError);
    const tampered = hook.body.replace('payment.succeeded', 'payment.failed');
    expect(() => provider.verifyWebhook(Buffer.from(tampered), hook.headers)).toThrow(
      InvalidSignatureError,
    );
    const otherSecret = hmacHex('another-secret', hook.body);
    expect(() =>
      provider.verifyWebhook(Buffer.from(hook.body), { [FAKE_SIGNATURE_HEADER]: otherSecret }),
    ).toThrow(InvalidSignatureError);
  });

  it('ignores authentic events that are not payment events', () => {
    const body = JSON.stringify({ id: 'e', type: 'refund.created' });
    const sig = hmacHex(secret, body);
    expect(provider.verifyWebhook(Buffer.from(body), { [FAKE_SIGNATURE_HEADER]: sig })).toBeNull();
  });

  it('refuses to be constructed in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new FakeProvider({ webhookSecret: secret })).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe('RazorpayTestProvider', () => {
  const base = { keySecret: 'secret', webhookSecret: 'whsec' };

  it('refuses live keys', () => {
    expect(() => new RazorpayTestProvider({ ...base, keyId: 'rzp_live_abc123' })).toThrow(
      /test keys/,
    );
    expect(() => new RazorpayTestProvider({ ...base, keyId: 'whatever' })).toThrow(/test keys/);
    expect(() => new RazorpayTestProvider({ ...base, keyId: 'rzp_test_abc123' })).not.toThrow();
  });

  it('creates an order carrying our payment id, with basic auth', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'order_ABC' }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new RazorpayTestProvider({ ...base, keyId: 'rzp_test_k', fetchImpl });
    const out = await p.createCharge(charge());
    expect(out.providerRef).toBe('order_ABC');
    expect(calls[0]!.url).toBe('https://api.razorpay.com/v1/orders');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      amount: 360000,
      currency: 'INR',
      receipt: 'pay_000001',
      notes: { paymentId: 'pay_000001', bookingId: 'bk-1' },
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('rzp_test_k:secret').toString('base64')}`,
    );
  });

  it('maps provider errors: 5xx/429/network are retryable, 4xx is a final rejection', async () => {
    const respond = (status: number) =>
      new RazorpayTestProvider({
        ...base,
        keyId: 'rzp_test_k',
        fetchImpl: (async () => new Response('{}', { status })) as unknown as typeof fetch,
      });
    await expect(respond(500).createCharge(charge())).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(respond(429).createCharge(charge())).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(respond(400).createCharge(charge())).rejects.toBeInstanceOf(ProviderRejectedError);
    const down = new RazorpayTestProvider({
      ...base,
      keyId: 'rzp_test_k',
      fetchImpl: (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });
    await expect(down.createCharge(charge())).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  describe('webhooks', () => {
    const p = new RazorpayTestProvider({ ...base, keyId: 'rzp_test_k' });
    const body = (event: string) =>
      JSON.stringify({
        event,
        payload: {
          payment: {
            entity: {
              id: 'pay_rzp1',
              order_id: 'order_ABC',
              amount: 360000,
              error_description: 'Your bank declined the payment',
              notes: { paymentId: 'pay_000001' },
            },
          },
        },
      });
    const signed = (raw: string, eventId = 'evt_1') => ({
      raw: Buffer.from(raw),
      headers: { 'x-razorpay-signature': hmacHex('whsec', raw), 'x-razorpay-event-id': eventId },
    });

    it('verifies the HMAC-SHA256 signature over the raw body (known vector)', () => {
      // vector computed independently with `openssl dgst -sha256 -hmac whsec`
      expect(hmacHex('whsec', '{}')).toBe(
        'ae6341ea7f40a435db57d903d02cba19085efb8a913f8cfbd8cff3d7df0c7a2d',
      );
      const { raw, headers } = signed(body('payment.captured'));
      expect(p.verifyWebhook(raw, headers)).toMatchObject({
        providerEventId: 'evt_1',
        paymentId: 'pay_000001',
        outcome: 'succeeded',
        providerRef: 'order_ABC',
        amountMinor: 360000,
      });
    });

    it('maps events: captured/order.paid succeed, payment.failed fails with the reason', () => {
      for (const ev of ['payment.captured', 'order.paid']) {
        const { raw, headers } = signed(body(ev));
        expect(p.verifyWebhook(raw, headers)!.outcome).toBe('succeeded');
      }
      const { raw, headers } = signed(body('payment.failed'));
      expect(p.verifyWebhook(raw, headers)).toMatchObject({
        outcome: 'failed',
        reason: 'Your bank declined the payment',
      });
    });

    it('ignores unrelated events, rejects bad signatures and missing ids', () => {
      const other = signed(body('refund.processed'));
      expect(p.verifyWebhook(other.raw, other.headers)).toBeNull();
      const good = signed(body('payment.captured'));
      expect(() =>
        p.verifyWebhook(good.raw, { ...good.headers, 'x-razorpay-signature': 'nope' }),
      ).toThrow(InvalidSignatureError);
      expect(() =>
        p.verifyWebhook(Buffer.from(body('payment.captured') + ' '), good.headers),
      ).toThrow(InvalidSignatureError);
      const noId = { 'x-razorpay-signature': good.headers['x-razorpay-signature'] };
      expect(() => p.verifyWebhook(good.raw, noId)).toThrow(/event id/);
    });
  });
});
