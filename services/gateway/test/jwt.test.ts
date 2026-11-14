import { createHmac } from 'node:crypto';
import { InvalidTokenError, signToken, verifyToken } from '../src';

const SECRET = 'a-test-secret-that-is-long-enough-123';
const now = () => 1_700_000_000_000;

describe('jwt', () => {
  it('round-trips claims', () => {
    const t = signToken({ sub: 'u1', role: 'attendee' }, SECRET, { now });
    expect(verifyToken(t, SECRET, now)).toMatchObject({ sub: 'u1', role: 'attendee' });
  });

  it('rejects a token signed with another secret', () => {
    const t = signToken({ sub: 'u1', role: 'attendee' }, 'other-secret-other-secret-other-1', {
      now,
    });
    expect(() => verifyToken(t, SECRET, now)).toThrow('bad signature');
  });

  it('rejects an expired token', () => {
    const t = signToken({ sub: 'u1', role: 'attendee' }, SECRET, { now, ttlSeconds: 60 });
    expect(() => verifyToken(t, SECRET, () => now() + 61_000)).toThrow('expired');
    expect(() => verifyToken(t, SECRET, () => now() + 59_000)).not.toThrow();
  });

  it('rejects a tampered payload (role escalation)', () => {
    const t = signToken({ sub: 'u1', role: 'attendee' }, SECRET, { now });
    const [h, , s] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'u1', role: 'organizer', iat: 1, exp: 9_999_999_999 }),
    ).toString('base64url');
    expect(() => verifyToken(`${h}.${forged}.${s}`, SECRET, now)).toThrow('bad signature');
  });

  it('rejects alg "none" and any other algorithm', () => {
    const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'u1', role: 'organizer', iat: 1, exp: 9_999_999_999 }),
    ).toString('base64url');
    expect(() => verifyToken(`${head}.${body}.`, SECRET, now)).toThrow('unsupported algorithm');
    const head2 = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const sig = createHmac('sha512', SECRET).update(`${head2}.${body}`).digest('base64url');
    expect(() => verifyToken(`${head2}.${body}.${sig}`, SECRET, now)).toThrow(
      'unsupported algorithm',
    );
  });

  it('rejects malformed tokens and unknown roles', () => {
    expect(() => verifyToken('nope', SECRET, now)).toThrow(InvalidTokenError);
    expect(() => verifyToken('a.b.c', SECRET, now)).toThrow(InvalidTokenError);
    const head = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'u', role: 'root', exp: 9_999_999_999 }),
    ).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
    expect(() => verifyToken(`${head}.${body}.${sig}`, SECRET, now)).toThrow('invalid role');
  });
});
