import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  TracerProvider,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';

export { SpanKind } from '@opentelemetry/api';

export interface TelemetryOptions {
  /** OTLP/HTTP endpoint, e.g. http://127.0.0.1:4318 . Defaults to OTEL_EXPORTER_OTLP_ENDPOINT. */
  endpoint?: string;
  /** Use this exporter instead (tests). Spans are exported immediately. */
  exporter?: SpanExporter;
}

export interface Telemetry {
  enabled: boolean;
  shutdown(): Promise<void>;
}

const TRACER = 'gatepass';

/**
 * Starts tracing for this process. Does NOTHING unless an endpoint or exporter is given, so
 * unconfigured runs and the unit tests pay no cost. Spans are linked across processes by the W3C
 * `traceparent` header, which travels on HTTP calls and on Kafka messages.
 */
export function initTelemetry(serviceName: string, opts: TelemetryOptions = {}): Telemetry {
  const endpoint = opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!opts.exporter && !endpoint) return { enabled: false, shutdown: async () => undefined };

  const processor = opts.exporter
    ? new SimpleSpanProcessor({ exporter: opts.exporter })
    : new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({ url: `${endpoint!.replace(/\/$/, '')}/v1/traces` }),
        scheduledDelayMillis: 1000,
      });
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    spanProcessors: [processor],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return { enabled: true, shutdown: () => provider.shutdown() };
}

/** Clears the global tracing setup (for tests that start their own). */
export function resetTelemetryForTests(): void {
  trace.disable();
  context.disable();
  propagation.disable();
}

const tracer = () => trace.getTracer(TRACER);

/** The W3C `traceparent` of the active span, or undefined when nothing is being traced. */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

/** Adds `traceparent` to outgoing headers when a span is active. */
export function injectTraceHeaders(headers: Record<string, string>): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}

/** The trace context carried by incoming headers (HTTP or Kafka), as an OpenTelemetry Context. */
export function extractContext(headers: Record<string, string | undefined>): Context {
  const carrier: Record<string, string> = {};
  if (headers.traceparent) carrier.traceparent = headers.traceparent;
  if (headers.tracestate) carrier.tracestate = headers.tracestate;
  return propagation.extract(context.active(), carrier);
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  /** Continue the trace carried by these headers (a message or request from another process). */
  parentHeaders?: Record<string, string | undefined>;
}

/**
 * Runs `fn` inside a span. The span ends when `fn` settles; an error marks it failed and is
 * rethrown. With no tracing configured this simply calls `fn`.
 */
export async function inSpan<T>(
  name: string,
  opts: SpanOptions,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const parent = opts.parentHeaders ? extractContext(opts.parentHeaders) : context.active();
  const span = tracer().startSpan(
    name,
    { kind: opts.kind ?? SpanKind.INTERNAL, attributes: opts.attributes },
    parent,
  );
  try {
    return await context.with(trace.setSpan(parent, span), () => fn(span));
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
}

/** Starts a span you end yourself (HTTP middleware); returns the context to run the request in. */
export function startManualSpan(name: string, opts: SpanOptions): { span: Span; ctx: Context } {
  const parent = opts.parentHeaders ? extractContext(opts.parentHeaders) : context.active();
  const span = tracer().startSpan(
    name,
    { kind: opts.kind ?? SpanKind.SERVER, attributes: opts.attributes },
    parent,
  );
  return { span, ctx: trace.setSpan(parent, span) };
}

export const activeSpanContext = (): SpanContext | undefined =>
  trace.getSpan(context.active())?.spanContext();
export { context as otelContext };
