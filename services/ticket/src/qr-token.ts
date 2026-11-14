import { createHmac, timingSafeEqual } from 'node:crypto';

export class InvalidQrTokenError extends Error {}

const PREFIX = 'GP1';
const b64 = (v: Buffer | string) => Buffer.from(v).toString('base64url');

/**
 * Signed QR tokens: `GP1.<payload>.<signature>`. The payload holds only ids (no personal data);
 * the signature is HMAC-SHA256 over `GP1.<payload>`. Keys have ids so they can be rotated: the
 * FIRST key signs, ANY key verifies. Spec: `kid:secret,kid2:secret2` (secrets >= 32 chars).
 */
export class QrKeyRing {
  private readonly keys = new Map<string, string>();
  private readonly signingKid: string;

  constructor(spec: string) {
    const entries = spec
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    if (entries.length === 0) throw new Error('TICKET_SIGNING_KEYS must list at least one key');
    for (const entry of entries) {
      const idx = entry.indexOf(':');
      const kid = entry.slice(0, idx);
      const secret = entry.slice(idx + 1);
      if (idx < 1 || secret.length < 32) {
        throw new Error(
          'each ticket signing key must look like "kid:secret" with a 32+ char secret',
        );
      }
      this.keys.set(kid, secret);
    }
    this.signingKid = entries[0]!.slice(0, entries[0]!.indexOf(':'));
  }

  sign(ticketId: string, eventId: string): string {
    const payload = b64(JSON.stringify({ t: ticketId, e: eventId, k: this.signingKid }));
    const sig = createHmac('sha256', this.keys.get(this.signingKid)!)
      .update(`${PREFIX}.${payload}`)
      .digest();
    return `${PREFIX}.${payload}.${b64(sig)}`;
  }

  /** Returns the ids inside a genuine token; throws InvalidQrTokenError for anything else. */
  verify(token: string): { ticketId: string; eventId: string } {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || parts[0] !== PREFIX) throw new InvalidQrTokenError('malformed token');
    const [, payload, sig] = parts as [string, string, string];

    let claims: { t?: unknown; e?: unknown; k?: unknown };
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new InvalidQrTokenError('malformed token');
    }
    const secret = typeof claims.k === 'string' ? this.keys.get(claims.k) : undefined;
    if (!secret) throw new InvalidQrTokenError('unknown key');

    const expected = createHmac('sha256', secret).update(`${PREFIX}.${payload}`).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new InvalidQrTokenError('bad signature');
    }
    if (typeof claims.t !== 'string' || typeof claims.e !== 'string') {
      throw new InvalidQrTokenError('malformed token');
    }
    return { ticketId: claims.t, eventId: claims.e };
  }
}
