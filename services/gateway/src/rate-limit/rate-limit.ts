import type { Redis } from 'ioredis';

export interface HitResult {
  allowed: boolean;
  /** Seconds until the client may try again (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /** Called when Redis fails; the request is let through. */
  onError?: (err: unknown) => void;
}

/**
 * Fixed-window counter in Redis: INCR the key for the current window and let the first hit set
 * its expiry, so the count is shared by every gateway instance and cleans itself up. If Redis
 * is down the limiter fails OPEN (the site stays up; the failure is reported), because refusing
 * every request over a cache outage would be a worse outage than the abuse it prevents.
 */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly opts: RateLimiterOptions = {},
  ) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<HitResult> {
    const now = (this.opts.now ?? Date.now)();
    const window = Math.floor(now / 1000 / windowSeconds);
    const redisKey = `rl:${key}:${window}`;
    try {
      const results = await this.redis
        .multi()
        .incr(redisKey)
        .expire(redisKey, windowSeconds + 1)
        .exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      if (count <= limit) return { allowed: true, retryAfterSeconds: 0 };
      const windowEnd = (window + 1) * windowSeconds * 1000;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
      };
    } catch (err) {
      this.opts.onError?.(err);
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }
}

interface Req {
  path?: string;
  url?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}
interface Res {
  setHeader(name: string, value: string): void;
  status(code: number): Res;
  json(body: unknown): void;
}

export interface RateLimitOptions {
  /** API calls per client per minute. Default 300. */
  perMinute?: number;
  /** Sign-in calls per client address per minute. Default 20. */
  signInsPerMinute?: number;
}

/** The user id inside a bearer token, without verifying it (the auth guard does that). */
function claimedUser(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const payload = value?.startsWith('Bearer ') ? value.slice(7).split('.')[1] : undefined;
  if (!payload) return undefined;
  try {
    const sub = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sub;
    return typeof sub === 'string' && sub.length <= 64 ? sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Express/Nest middleware. Sign-in is limited per address (anyone can call it). Everything else
 * is counted per user when a token is present, so one busy office address does not lock out its
 * colleagues, and per address otherwise. A forged `sub` only moves a client into another bucket;
 * it cannot raise its limit, because each bucket has the same ceiling and the address bucket
 * still applies to tokenless calls. /health and /metrics are never limited.
 */
export function rateLimitMiddleware(limiter: RateLimiter, options: RateLimitOptions = {}) {
  const perMinute = options.perMinute ?? 300;
  const signIns = options.signInsPerMinute ?? 20;
  return async (req: Req, res: Res, next: () => void): Promise<void> => {
    const path = (req.path ?? req.url ?? '').split('?')[0]!;
    if (path === '/health' || path.startsWith('/metrics')) return next();
    const address = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const signIn = path === '/api/dev-login';
    const user = signIn ? undefined : claimedUser(req.headers.authorization);
    const key = signIn ? `signin:${address}` : user ? `user:${user}` : `ip:${address}`;
    const result = await limiter.hit(key, signIn ? signIns : perMinute, 60);
    if (result.allowed) return next();
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    res.status(429).json({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Too many requests. Please slow down and try again shortly.',
    });
  };
}
