/** A named dependency probe: resolves when the dependency works, rejects when it does not. */
export type ReadinessChecks = Record<string, () => Promise<unknown>>;

export interface ReadinessResult {
  ready: boolean;
  body: { status: 'ready' | 'not ready'; service: string; checks: Record<string, string> };
}

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs every probe in parallel (each capped at 2 s). The answer names what failed but never
 * echoes the error text, which could carry hosts or credentials.
 */
export async function checkReadiness(
  service: string,
  checks: ReadinessChecks,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<ReadinessResult> {
  const names = Object.keys(checks);
  const outcomes = await Promise.all(
    names.map((n) =>
      withTimeout(Promise.resolve().then(checks[n]!), timeoutMs).then(
        () => 'ok',
        () => 'failed',
      ),
    ),
  );
  const result: Record<string, string> = Object.fromEntries(names.map((n, i) => [n, outcomes[i]!]));
  const ready = outcomes.every((o) => o === 'ok');
  return { ready, body: { status: ready ? 'ready' : 'not ready', service, checks: result } };
}

interface Res {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}
interface AppLike {
  getHttpAdapter(): {
    get(path: string, handler: (req: unknown, res: unknown) => unknown): unknown;
  };
}

/** Writes a readiness answer: 200 when every check passes, 503 when any fails. */
export async function sendReadiness(
  res: Res,
  service: string,
  checks: ReadinessChecks,
): Promise<void> {
  const { ready, body } = await checkReadiness(service, checks);
  res.statusCode = ready ? 200 : 503;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/**
 * Adds `GET /ready` (readiness: can this service do its job right now?) next to `/health`
 * (liveness: is the process up?). Use it as the probe a load balancer or deploy script waits on.
 */
export function mountReadiness(app: unknown, service: string, checks: ReadinessChecks): void {
  (app as AppLike)
    .getHttpAdapter()
    .get('/ready', (_req, res) => sendReadiness(res as Res, service, checks));
}
