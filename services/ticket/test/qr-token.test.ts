import { InvalidQrTokenError, QrKeyRing } from '../src';

const K1 = 'k1:' + 'a'.repeat(40);
const K2 = 'k2:' + 'b'.repeat(40);

describe('QrKeyRing', () => {
  it('signs and verifies, carrying only ids', () => {
    const ring = new QrKeyRing(K1);
    const token = ring.sign('ticket-1', 'event-1');
    expect(token).toMatch(/^GP1\.[\w-]+\.[\w-]+$/);
    expect(ring.verify(token)).toEqual({ ticketId: 'ticket-1', eventId: 'event-1' });
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['e', 'k', 't']); // no name, email, seat or price
  });

  it('rejects tampering with the payload or the signature', () => {
    const ring = new QrKeyRing(K1);
    const [p, payload, sig] = ring.sign('ticket-1', 'event-1').split('.');
    const forged = Buffer.from(JSON.stringify({ t: 'ticket-2', e: 'event-1', k: 'k1' })).toString(
      'base64url',
    );
    expect(() => ring.verify(`${p}.${forged}.${sig}`)).toThrow('bad signature');
    expect(() => ring.verify(`${p}.${payload}.${sig!.slice(0, -2)}AA`)).toThrow(
      InvalidQrTokenError,
    );
    expect(() => ring.verify(`${p}.${payload}.`)).toThrow(InvalidQrTokenError);
  });

  it('rejects malformed input of every kind', () => {
    const ring = new QrKeyRing(K1);
    for (const bad of ['', 'x', 'a.b', 'GP1.a', 'GP2.a.b', 'GP1.not-json.sig', 'GP1..']) {
      expect(() => ring.verify(bad)).toThrow(InvalidQrTokenError);
    }
    expect(() => ring.verify(undefined as unknown as string)).toThrow(InvalidQrTokenError);
  });

  it('rejects a token signed with a key this ring does not know', () => {
    const other = new QrKeyRing('zz:' + 'c'.repeat(40));
    expect(() => new QrKeyRing(K1).verify(other.sign('t', 'e'))).toThrow('unknown key');
    // same key id, different secret
    const impostor = new QrKeyRing('k1:' + 'd'.repeat(40));
    expect(() => new QrKeyRing(K1).verify(impostor.sign('t', 'e'))).toThrow('bad signature');
  });

  it('supports rotation: new key signs, old key still verifies', () => {
    const oldRing = new QrKeyRing(K1);
    const oldToken = oldRing.sign('ticket-1', 'event-1');
    const rotated = new QrKeyRing(`${K2},${K1}`);
    expect(rotated.verify(oldToken)).toEqual({ ticketId: 'ticket-1', eventId: 'event-1' });
    const newToken = rotated.sign('ticket-2', 'event-1');
    expect(JSON.parse(Buffer.from(newToken.split('.')[1]!, 'base64url').toString()).k).toBe('k2');
    expect(() => oldRing.verify(newToken)).toThrow('unknown key'); // old deployment cannot read new tokens
    expect(() => new QrKeyRing(K2).verify(oldToken)).toThrow('unknown key'); // once retired, old tokens die
  });

  it('refuses weak or malformed key configuration', () => {
    expect(() => new QrKeyRing('')).toThrow();
    expect(() => new QrKeyRing('k1:short')).toThrow(/32\+/);
    expect(() => new QrKeyRing('nokeyid')).toThrow();
  });
});
