/**
 * Replaying dead letters.
 *
 * A consumer that cannot process a message (after its retries) copies the ORIGINAL bytes to
 * `<group>.dlq` with `x-dlq-*` headers saying where it came from and why it failed. Once the cause
 * is fixed, replaying means putting that message back on its original topic.
 *
 * Every other consumer group on that topic sees it again too. That is harmless: each consumer
 * records processed event ids in its inbox, so a message it already handled is ignored.
 */

export interface DlqRecord {
  topic: string; // the DLQ topic
  partition: number;
  offset: string;
  key: string | null;
  value: Uint8Array | null;
  headers: Record<string, string>;
}

export interface ReplayMessage {
  topic: string;
  key: string | null;
  value: Uint8Array;
  headers: Record<string, string>;
}

export type SkipReason = 'no_original_topic' | 'no_value' | 'filtered' | 'limit';

/** The republishable form of a dead letter, or why it cannot be republished. */
export function toReplayMessage(
  record: DlqRecord,
): { ok: true; message: ReplayMessage } | { ok: false; reason: SkipReason } {
  const topic = record.headers['x-dlq-original-topic'];
  if (!topic) return { ok: false, reason: 'no_original_topic' };
  if (!record.value) return { ok: false, reason: 'no_value' };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(record.headers)) if (!k.startsWith('x-dlq-')) headers[k] = v;
  headers['x-replayed-from'] = record.topic;
  headers['x-replayed-offset'] = `${record.partition}:${record.offset}`;
  return { ok: true, message: { topic, key: record.key, value: record.value, headers } };
}

export interface ReplayOptions {
  /** Only replay the dead letter(s) for this event id. */
  eventId?: string;
  /** Replay at most this many. */
  limit?: number;
  /** Say what would happen; publish nothing. */
  dryRun?: boolean;
}

export interface ReplayReport {
  replayed: ReplayMessage[];
  skipped: { record: DlqRecord; reason: SkipReason }[];
}

/**
 * Decides what to replay (in DLQ order) and, unless `dryRun`, publishes it. `publish` must resolve
 * only once the broker has accepted the message; if it throws, nothing after it is attempted.
 */
export async function replayRecords(
  records: DlqRecord[],
  publish: (message: ReplayMessage) => Promise<void>,
  opts: ReplayOptions = {},
): Promise<ReplayReport> {
  const report: ReplayReport = { replayed: [], skipped: [] };
  for (const record of records) {
    if (opts.eventId && record.headers.eventId !== opts.eventId) {
      report.skipped.push({ record, reason: 'filtered' });
      continue;
    }
    if (opts.limit !== undefined && report.replayed.length >= opts.limit) {
      report.skipped.push({ record, reason: 'limit' });
      continue;
    }
    const prepared = toReplayMessage(record);
    if (!prepared.ok) {
      report.skipped.push({ record, reason: prepared.reason });
      continue;
    }
    if (!opts.dryRun) await publish(prepared.message);
    report.replayed.push(prepared.message);
  }
  return report;
}

export interface ReplayArgs extends ReplayOptions {
  dlq: string;
  brokers: string[];
}

/** `--dlq booking.dlq --brokers a:9092,b:9092 [--limit 10] [--event-id ID] [--dry-run]` */
export function parseReplayArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ReplayArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
    const name = a.slice(2);
    if (name === 'dry-run') flags.add(name);
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
      values.set(name, v);
    }
  }
  const known = new Set(['dlq', 'brokers', 'limit', 'event-id']);
  for (const k of values.keys()) if (!known.has(k)) throw new Error(`unknown option --${k}`);

  const dlq = values.get('dlq');
  if (!dlq || !dlq.endsWith('.dlq')) throw new Error('--dlq <consumer>.dlq is required');
  const brokers = (values.get('brokers') ?? env.KAFKA_BROKERS ?? '').split(',').filter(Boolean);
  if (brokers.length === 0) throw new Error('--brokers (or KAFKA_BROKERS) is required');
  const limitText = values.get('limit');
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a positive whole number');
  }
  return { dlq, brokers, limit, eventId: values.get('event-id'), dryRun: flags.has('dry-run') };
}
