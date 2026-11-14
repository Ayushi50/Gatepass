import { createHmac, timingSafeEqual } from 'node:crypto';

export type Role = 'attendee' | 'organizer' | 'door-staff';
export const ROLES: readonly Role[] = ['attendee', 'organizer', 'door-staff'];

export interface Claims {
  sub: string; // user id
  role: Role;
  iat: number; // seconds
  exp: number; // seconds
}

export class InvalidTokenError extends Error {}

const b64 = (input: Buffer | string) => Buffer.from(input).toString('base64url');

const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest();

/** Signs an HS256 JWT. Used by the dev-token script and tests; real login arrives later. */
export function signToken(
  claims: { sub: string; role: Role },
  secret: string,
  opts: { ttlSeconds?: number; now?: () => number } = {},
): string {
  const iat = Math.floor((opts.now ?? Date.now)() / 1000);
  const body: Claims = { ...claims, iat, exp: iat + (opts.ttlSeconds ?? 3600) };
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify(body));
  return `${head}.${payload}.${b64(sign(`${head}.${payload}`, secret))}`;
}

/** Verifies signature (constant time), algorithm, expiry and claim shape. Throws InvalidTokenError. */
export function verifyToken(token: string, secret: string, now: () => number = Date.now): Claims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new InvalidTokenError('malformed token');
  const [head, payload, sig] = parts as [string, string, string];

  let header: { alg?: string };
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidTokenError('malformed token');
  }
  // Pin the algorithm: never trust the token to choose it ("alg: none" attack).
  if (header.alg !== 'HS256') throw new InvalidTokenError('unsupported algorithm');

  const expected = sign(`${head}.${payload}`, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new InvalidTokenError('bad signature');
  }

  let claims: Partial<Claims>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidTokenError('malformed token');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new InvalidTokenError('missing sub');
  if (!claims.role || !ROLES.includes(claims.role)) throw new InvalidTokenError('invalid role');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now()) {
    throw new InvalidTokenError('token expired');
  }
  return claims as Claims;
}
