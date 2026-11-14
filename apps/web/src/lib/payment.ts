export type PayMethod = 'upi' | 'card' | 'net';

/** The gateway's names for the methods. */
export const GATEWAY_METHOD: Record<PayMethod, 'upi' | 'card' | 'netbanking'> = {
  upi: 'upi',
  card: 'card',
  net: 'netbanking',
};

/**
 * TEST MODE ONLY. What the form's input means to the FAKE payment provider.
 * The card number, UPI id and CVC are read here, in the browser, to choose a test token, and are
 * never sent anywhere: only the token travels. With a real provider this function is replaced by
 * that provider's own checkout, which hands back a token for what the customer typed.
 *
 *   card 4000 0000 0000 0002 or a UPI id ending "@fail"  -> declined
 *   card 4000 0000 0000 0069                              -> refused outright
 *   anything else                                         -> succeeds
 */
export function testToken(method: PayMethod, input: { upi?: string; card?: string }): string {
  const card = (input.card ?? '').replace(/\D/g, '');
  const upi = (input.upi ?? '').trim().toLowerCase();
  if (method === 'card' && card === '4000000000000002') return 'tok_declined';
  if (method === 'card' && card === '4000000000000069') return 'tok_rejected';
  if (method === 'upi' && upi.endsWith('@fail')) return 'tok_declined';
  return 'tok_success';
}
