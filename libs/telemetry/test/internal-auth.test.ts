import { internalAuth, mountInternalAuth, requireInternalToken } from '../src';

const TOKEN = 't'.repeat(40);

function run(path: string, headers: Record<string, string> = {}) {
  let status = 200;
  let nextCalled = false;
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    end: () => void (status = res.statusCode),
  };
  internalAuth(TOKEN)({ url: path, headers }, res, () => void (nextCalled = true));
  return { status, nextCalled };
}

describe('internal service token (F-04)', () => {
  it('refuses a call with no token, or the wrong one', () => {
    expect(run('/bookings/1')).toEqual({ status: 401, nextCalled: false });
    expect(run('/bookings/1', { 'x-internal-token': 'wrong' })).toEqual({
      status: 401,
      nextCalled: false,
    });
    expect(run('/bookings/1', { 'x-user-id': 'mallory' }).nextCalled).toBe(false);
  });
  it('lets the right token through, query string included', () => {
    expect(run('/tickets?userId=a', { 'x-internal-token': TOKEN }).nextCalled).toBe(true);
  });
  it('leaves /health, /metrics and provider webhooks open', () => {
    for (const p of ['/health', '/metrics', '/webhooks/razorpay'])
      expect(run(p).nextCalled).toBe(true);
    expect(run('/healthy-ish').nextCalled).toBe(false);
  });
  it('a service refuses to start without a 32+ character token', () => {
    expect(() => requireInternalToken({})).toThrow(/INTERNAL_TOKEN/);
    expect(() => requireInternalToken({ INTERNAL_TOKEN: 'short' })).toThrow(/INTERNAL_TOKEN/);
    expect(() => mountInternalAuth({ use: () => undefined }, {})).toThrow(/INTERNAL_TOKEN/);
    expect(requireInternalToken({ INTERNAL_TOKEN: TOKEN })).toBe(TOKEN);
  });
});
