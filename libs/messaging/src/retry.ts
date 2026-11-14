export interface RetryPolicy {
  /** Total attempts including the first. Default 5. */
  maxAttempts: number;
  /** Delay before the 2nd attempt. Doubles each time. Default 200ms. */
  baseDelayMs: number;
  /** Cap on a single delay. Default 10s. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
};

export interface RetryDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Returns [0,1). Injectable so tests are deterministic. */
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/** Exponential backoff with full jitter: random in [0, min(max, base * 2^(attempt-1))]. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export class RetriesExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(
      `gave up after ${attempts} attempts: ${String((lastError as Error)?.message ?? lastError)}`,
    );
    this.name = 'RetriesExhaustedError';
  }
}

/** Runs `fn`, retrying with backoff. Throws RetriesExhaustedError after maxAttempts failures. */
export async function runWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  deps: RetryDeps = {},
): Promise<T> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === policy.maxAttempts) break;
      const delayMs = backoffDelayMs(attempt, policy, deps.random);
      deps.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw new RetriesExhaustedError(policy.maxAttempts, lastError);
}
