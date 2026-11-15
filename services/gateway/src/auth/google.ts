import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { signToken, type Role } from './jwt';

export interface GoogleOptions {
  clientId: string;
  clientSecret: string;
  /** Where Google sends the browser back. Must be registered with Google, and on the web app's origin. */
  redirectUri: string;
  /** Emails that become organizers / door staff. Everyone else who signs in is an attendee. */
  organizerEmails?: string[];
  doorStaffEmails?: string[];
  /** The organizer id the seeded shows belong to; every organizer signs in as this one for now. */
  organizerId?: string;
  authUrl?: string;
  tokenUrl?: string;
  /** Injectable clock (epoch ms) and HTTP, for tests. */
  now?: () => number;
  fetch?: typeof fetch;
}

const STATE_TTL_MS = 10 * 60_000;
export const GOOGLE_COOKIE = 'gp_oauth';

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Only ever a path on this site; anything else becomes "". */
export function safeNext(next: unknown): string {
  return typeof next === 'string' &&
    next.startsWith('/') &&
    !next.startsWith('//') &&
    !next.includes('\\') &&
    next.length < 500
    ? next
    : '';
}

export class SignInError extends Error {}

/**
 * "Sign in with Google", the authorization-code flow.
 *
 *  1. start(): a signed `state` (random nonce, return page, expiry, and a hash of a random value
 *     that is also set as an HttpOnly cookie) goes to Google.
 *  2. finish(): the callback must carry that state AND that cookie, so a link forged by someone
 *     else cannot sign you in as them. The code is exchanged for an ID token over TLS straight
 *     from Google's token endpoint, and its audience, issuer, expiry, nonce and verified email
 *     are checked. Then a normal Gatepass token is minted.
 */
export class GoogleAuth {
  constructor(
    private readonly o: GoogleOptions,
    private readonly secret: string,
  ) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }
  private mac(data: string) {
    return b64(createHmac('sha256', this.secret).update(`google-state:${data}`).digest());
  }

  start(next: unknown): { location: string; cookie: string } {
    const browser = randomBytes(24).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const body = b64(
      JSON.stringify({
        b: sha(browser),
        n: nonce,
        next: safeNext(next),
        exp: this.now() + STATE_TTL_MS,
      }),
    );
    const state = `${body}.${this.mac(body)}`;
    const url = new URL(this.o.authUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.o.clientId,
      redirect_uri: this.o.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      prompt: 'select_account',
    }).toString();
    const secure = this.o.redirectUri.startsWith('https:') ? '; Secure' : '';
    return {
      location: url.toString(),
      cookie: `${GOOGLE_COOKIE}=${browser}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=${STATE_TTL_MS / 1000}${secure}`,
    };
  }

  async finish(q: {
    code?: string;
    state?: string;
    error?: string;
    cookie?: string;
  }): Promise<{ token: string; next: string }> {
    const [body, sig] = (q.state ?? '').split('.');
    if (!body || !sig || !same(sig, this.mac(body))) throw new SignInError('bad_state');
    let st: { b: string; n: string; next: string; exp: number };
    try {
      st = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new SignInError('bad_state');
    }
    if (st.exp < this.now()) throw new SignInError('expired');
    if (!q.cookie || !same(sha(q.cookie), st.b)) throw new SignInError('bad_state');
    if (q.error) throw new SignInError(q.error === 'access_denied' ? 'cancelled' : 'google_error');
    if (!q.code) throw new SignInError('bad_state');

    const res = await (this.o.fetch ?? fetch)(
      this.o.tokenUrl ?? 'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: q.code,
          client_id: this.o.clientId,
          client_secret: this.o.clientSecret,
          redirect_uri: this.o.redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      },
    ).catch(() => undefined);
    if (!res?.ok) throw new SignInError('google_rejected');
    const idToken = ((await res.json().catch(() => ({}))) as { id_token?: string }).id_token;

    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(idToken!.split('.')[1]!, 'base64url').toString('utf8'));
    } catch {
      throw new SignInError('bad_token');
    }
    const issuerOk =
      claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    if (!issuerOk || claims.aud !== this.o.clientId) throw new SignInError('bad_token');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < this.now())
      throw new SignInError('bad_token');
    if (claims.nonce !== st.n) throw new SignInError('bad_token');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new SignInError('bad_token');
    if (claims.email_verified !== true || typeof claims.email !== 'string')
      throw new SignInError('email_not_verified');

    const email = claims.email.toLowerCase();
    const listed = (l?: string[]) => (l ?? []).some((e) => e.trim().toLowerCase() === email);
    const role: Role = listed(this.o.organizerEmails)
      ? 'organizer'
      : listed(this.o.doorStaffEmails)
        ? 'door-staff'
        : 'attendee';
    const sub = role === 'organizer' ? (this.o.organizerId ?? 'org-demo') : `g-${claims.sub}`;
    return {
      token: signToken({ sub, role }, this.secret, { ttlSeconds: 8 * 3600, now: this.o.now }),
      next: st.next,
    };
  }
}

export const GOOGLE = Symbol('GOOGLE');
