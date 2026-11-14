import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import {
  currentTraceparent,
  httpTelemetry,
  initTelemetry,
  injectTraceHeaders,
  inSpan,
  metrics,
  metricsText,
  registry,
  resetTelemetryForTests,
} from '../src';

const exporter = new InMemorySpanExporter();
const names = () => exporter.getFinishedSpans().map((s) => s.name);
const byName = (n: string) => exporter.getFinishedSpans().find((s) => s.name === n)!;

describe('with tracing OFF (the default)', () => {
  it('costs nothing and changes nothing: no endpoint, no spans, no traceparent', async () => {
    const t = initTelemetry('svc');
    expect(t.enabled).toBe(false);
    expect(currentTraceparent()).toBeUndefined();
    expect(await inSpan('x', {}, () => 41 + 1)).toBe(42);
    expect(injectTraceHeaders({ a: 'b' })).toEqual({ a: 'b' });
    await t.shutdown();
  });
});

describe('with tracing ON', () => {
  beforeAll(() => {
    resetTelemetryForTests();
    expect(initTelemetry('svc', { exporter }).enabled).toBe(true);
  });
  afterEach(() => exporter.reset());

  it('nests spans and gives them one trace', async () => {
    await inSpan('outer', {}, async () => {
      await inSpan(
        'inner',
        { attributes: { 'gatepass.correlation_id': 'b-1' } },
        async () => undefined,
      );
    });
    const [outer, inner] = [byName('outer'), byName('inner')];
    expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(inner.attributes['gatepass.correlation_id']).toBe('b-1');
  });

  it('a traceparent carried in headers continues the trace in another "process"', async () => {
    let tp: string | undefined;
    await inSpan('producer', {}, () => void (tp = currentTraceparent()));
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    await inSpan('consumer', { parentHeaders: { traceparent: tp } }, async () => undefined);
    expect(byName('consumer').spanContext().traceId).toBe(byName('producer').spanContext().traceId);
    expect(byName('consumer').parentSpanContext?.spanId).toBe(
      byName('producer').spanContext().spanId,
    );
  });

  it('a failing span is marked failed, keeps the error, and the error still propagates', async () => {
    await expect(inSpan('boom', {}, () => Promise.reject(new Error('nope')))).rejects.toThrow(
      'nope',
    );
    const s = byName('boom');
    expect(s.status.code).toBe(2); // ERROR
    expect(s.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('outgoing HTTP headers get the active trace', async () => {
    await inSpan('call', {}, async () => {
      expect(injectTraceHeaders({})).toHaveProperty('traceparent');
    });
  });

  it("the HTTP middleware continues the caller's trace, names the span by ROUTE and times it", async () => {
    let tp: string | undefined;
    await inSpan('caller', {}, () => void (tp = currentTraceparent()));
    const finish: (() => void)[] = [];
    const req = {
      method: 'GET',
      url: '/api/bookings/b-123',
      path: '/api/bookings/b-123',
      headers: { traceparent: tp },
      route: { path: '/bookings/:id' },
      baseUrl: '/api',
    };
    const res = {
      statusCode: 200,
      on: (_e: 'finish', cb: () => void) => void finish.push(cb),
      setHeader: () => undefined,
      end: () => undefined,
    };
    httpTelemetry('gateway')(req as never, res as never, () => undefined);
    finish.forEach((f) => f());

    const server = exporter.getFinishedSpans().find((s) => s.name.startsWith('GET /api'))!;
    expect(server.name).toBe('GET /api/bookings/:id'); // never the raw URL with the id
    expect(server.spanContext().traceId).toBe(byName('caller').spanContext().traceId);
    const text = await metricsText();
    expect(text).toContain(
      'gatepass_http_request_duration_seconds_count{service="gateway",method="GET",route="/api/bookings/:id",status="200"} 1',
    );
    expect(text).not.toContain('b-123');
  });
});

describe('metrics', () => {
  it('asking twice returns the same metric, so libraries can share them', () => {
    expect(metrics.bookingsConfirmed()).toBe(metrics.bookingsConfirmed());
  });
  it('counters and histograms are exposed in the Prometheus text format', async () => {
    metrics.bookingsCancelled().inc({ reason: 'hold_expired' });
    metrics.paymentDuration().observe({ outcome: 'succeeded' }, 0.42);
    const text = await metricsText();
    expect(text).toContain('gatepass_bookings_cancelled_total{reason="hold_expired"} 1');
    expect(text).toContain(
      'gatepass_payment_duration_seconds_bucket{le="0.5",outcome="succeeded"} 1',
    );
    expect(text).toContain('# TYPE gatepass_payment_duration_seconds histogram');
    expect(registry.contentType).toContain('text/plain');
  });
});
