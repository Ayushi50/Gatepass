import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { metrics, metricsContentType, metricsText } from './metrics';
import { startManualSpan } from './tracing';

interface Req {
  method: string;
  url: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  baseUrl?: string;
}
interface Res {
  statusCode: number;
  on(event: 'finish', cb: () => void): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}
type Next = () => void;

const flat = (h: Req['headers']): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));

/**
 * Express/Nest middleware: continues the caller's trace, times the request, and counts it under
 * the matched ROUTE (`/api/bookings/:id`), never the raw URL, so ids cannot blow up the series.
 */
export function httpTelemetry(service: string) {
  const duration = metrics.httpDuration();
  return (req: Req, res: Res, next: Next): void => {
    if ((req.path ?? req.url).startsWith('/metrics')) return next();
    const started = process.hrtime.bigint();
    const { span, ctx } = startManualSpan(`${req.method} ${(req.path ?? req.url).split('?')[0]}`, {
      kind: SpanKind.SERVER,
      parentHeaders: flat(req.headers),
      attributes: { 'http.method': req.method, 'service.name': service },
    });
    res.on('finish', () => {
      const route = `${req.baseUrl ?? ''}${req.route?.path ?? ''}` || 'unmatched';
      span.updateName(`${req.method} ${route}`);
      span.setAttribute('http.route', route);
      span.setAttribute('http.status_code', res.statusCode);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      duration.observe(
        { service, method: req.method, route, status: String(res.statusCode) },
        Number(process.hrtime.bigint() - started) / 1e9,
      );
    });
    context.with(ctx, next);
  };
}

/** `GET /metrics` for any Node HTTP server. */
export async function serveMetrics(res: Res): Promise<void> {
  res.setHeader('content-type', metricsContentType());
  res.end(await metricsText());
}

export { trace };

interface AppLike {
  use(fn: unknown): unknown;
  getHttpAdapter(): {
    get(path: string, handler: (req: unknown, res: unknown) => unknown): unknown;
  };
}

/** Adds the request middleware (traces, timings), `GET /metrics` and `GET /health` (liveness) to a Nest/Express app. */
export function mountTelemetry(app: unknown, service: string): void {
  const a = app as AppLike;
  a.use(httpTelemetry(service));
  a.getHttpAdapter().get('/metrics', (_req, res) => serveMetrics(res as Res));
  a.getHttpAdapter().get('/health', (_req, res) => {
    const r = res as Res;
    r.setHeader('content-type', 'application/json; charset=utf-8');
    r.end(JSON.stringify({ status: 'ok', service }));
  });
}
