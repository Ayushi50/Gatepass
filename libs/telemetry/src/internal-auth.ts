import { timingSafeEqual } from 'node:crypto';

/** Header the gateway sends on every call to an internal service. */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/** Paths an internal service answers without the token (liveness, readiness, metrics, provider webhooks). */
const OPEN_PREFIXES = ['/health', '/ready', '/metrics', '/webhooks/'];

interface Req {
  url: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

const MIN_LENGTH = 32;

/** Reads INTERNAL_TOKEN and refuses to start without a real one (32+ characters). */
export function requireInternalToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.INTERNAL_TOKEN;
  if (!token || token.length < MIN_LENGTH) {
    throw new Error(`INTERNAL_TOKEN is required (${MIN_LENGTH}+ characters): see .env.example`);
  }
  return token;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Express/Nest middleware for the INTERNAL services (not the gateway): every request must carry
 * the shared token, so a caller who reaches the port directly cannot act as any user.
 * `/health`, `/ready`, `/metrics` and `/webhooks/*` (signature-checked by the payment provider code) stay open.
 */
export function internalAuth(token: string) {
  return (req: Req, res: Res, next: () => void): void => {
    const path = (req.path ?? req.url).split('?')[0]!;
    if (OPEN_PREFIXES.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`))) {
      return next();
    }
    const sent = req.headers[INTERNAL_TOKEN_HEADER];
    const value = Array.isArray(sent) ? sent[0] : sent;
    if (typeof value === 'string' && same(value, token)) return next();
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ statusCode: 401, message: 'internal service: token required' }));
  };
}

interface AppLike {
  use(fn: unknown): unknown;
}

/** Call right after `mountTelemetry` in every internal service. Throws if INTERNAL_TOKEN is unset. */
export function mountInternalAuth(app: unknown, env: NodeJS.ProcessEnv = process.env): void {
  (app as AppLike).use(internalAuth(requireInternalToken(env)));
}
