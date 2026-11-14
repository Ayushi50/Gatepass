import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** One registry per process. Every service exposes it on /metrics. */
export const registry = new Registry();
let defaultsOn = false;

/** Process metrics (CPU, memory, event loop). Call once at start-up. */
export function collectProcessMetrics(): void {
  if (defaultsOn) return;
  defaultsOn = true;
  collectDefaultMetrics({ register: registry, prefix: 'gatepass_process_' });
}

/** Get-or-create, so a metric defined in a library can be asked for from many places. */
export function counter(name: string, help: string, labelNames: string[] = []): Counter<string> {
  return (
    (registry.getSingleMetric(name) as Counter<string> | undefined) ??
    new Counter({ name, help, labelNames, registers: [registry] })
  );
}

export function gauge(name: string, help: string, labelNames: string[] = []): Gauge<string> {
  return (
    (registry.getSingleMetric(name) as Gauge<string> | undefined) ??
    new Gauge({ name, help, labelNames, registers: [registry] })
  );
}

/** A gauge whose value is read at scrape time (queue depth, lag), not pushed. */
export function collectedGauge(
  name: string,
  help: string,
  labelNames: string[],
  collect: (g: Gauge<string>) => Promise<void> | void,
): Gauge<string> {
  const existing = registry.getSingleMetric(name) as Gauge<string> | undefined;
  if (existing) return existing;
  return new Gauge({
    name,
    help,
    labelNames,
    registers: [registry],
    async collect() {
      await collect(this as unknown as Gauge<string>);
    },
  });
}

export function histogram(
  name: string,
  help: string,
  labelNames: string[] = [],
  buckets?: number[],
): Histogram<string> {
  return (
    (registry.getSingleMetric(name) as Histogram<string> | undefined) ??
    new Histogram({ name, help, labelNames, buckets, registers: [registry] })
  );
}

/** Latency buckets from 5 ms to 60 s: enough resolution to read a p95 from. */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export async function metricsText(): Promise<string> {
  return registry.metrics();
}
export const metricsContentType = (): string => registry.contentType;

/** The metrics every business event feeds. Label values are small fixed sets, never ids. */
export const metrics = {
  bookingsRequested: () => counter('gatepass_bookings_requested_total', 'Bookings requested.'),
  bookingsConfirmed: () =>
    counter('gatepass_bookings_confirmed_total', 'Bookings confirmed (paid, seats sold).'),
  bookingsCancelled: () =>
    counter('gatepass_bookings_cancelled_total', 'Bookings cancelled.', ['reason']),
  holdsCreated: () => counter('gatepass_holds_created_total', 'Seat holds created.'),
  holdsFailed: () => counter('gatepass_holds_failed_total', 'Seat holds refused.', ['reason']),
  holdsExpired: () => counter('gatepass_holds_expired_total', 'Seat holds that expired unpaid.'),
  salesFailed: () =>
    counter(
      'gatepass_sales_failed_total',
      'Payments that arrived after their hold was released (refunded).',
    ),
  paymentsFinished: () =>
    counter('gatepass_payments_total', 'Payments that reached a final state.', ['outcome']),
  paymentDuration: () =>
    histogram(
      'gatepass_payment_duration_seconds',
      'Time from a payment being created to its final outcome.',
      ['outcome'],
      LATENCY_BUCKETS,
    ),
  refundsCompleted: () =>
    counter('gatepass_refunds_completed_total', 'Refunds completed.', ['kind']),
  checkIns: () => counter('gatepass_checkins_total', 'Door scans.', ['result']),
  consumed: () =>
    counter('gatepass_consumed_total', 'Messages a consumer finished with.', [
      'consumer',
      'outcome',
    ]),
  consumeDuration: () =>
    histogram(
      'gatepass_consume_duration_seconds',
      'Time a consumer spent on one message, retries included.',
      ['consumer'],
      LATENCY_BUCKETS,
    ),
  retries: () =>
    counter('gatepass_consumer_retries_total', 'Retries of a failing message.', ['consumer']),
  deadLetters: () =>
    counter('gatepass_dead_letters_total', 'Messages sent to a dead-letter topic.', ['consumer']),
  duplicatesIgnored: () =>
    counter(
      'gatepass_consumer_duplicates_ignored_total',
      'Duplicate deliveries ignored by an inbox.',
      ['consumer'],
    ),
  consumerLag: () =>
    gauge('gatepass_consumer_lag', 'Messages a consumer group has not yet read.', [
      'group',
      'topic',
    ]),
  dlqDepth: () => gauge('gatepass_dlq_depth', 'Messages sitting in a dead-letter topic.', ['dlq']),
  httpDuration: () =>
    histogram(
      'gatepass_http_request_duration_seconds',
      'HTTP request duration.',
      ['service', 'method', 'route', 'status'],
      LATENCY_BUCKETS,
    ),
};
