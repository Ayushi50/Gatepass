import { dlqTopicFor } from './handler';
import { metrics } from '@gatepass/telemetry';

/** The slice of kafkajs's admin client the monitor uses (so tests can fake it). */
export interface AdminLike {
  fetchOffsets(o: {
    groupId: string;
    topics: string[];
  }): Promise<{ topic: string; partitions: { partition: number; offset: string }[] }[]>;
  fetchTopicOffsets(
    topic: string,
  ): Promise<{ partition: number; offset: string; high: string; low: string }[]>;
}

/** Messages in `topic` that `groupId` has not yet read, summed over partitions. */
export async function measureLag(
  admin: AdminLike,
  groupId: string,
  topic: string,
): Promise<number> {
  const [end, committed] = await Promise.all([
    admin.fetchTopicOffsets(topic),
    admin.fetchOffsets({ groupId, topics: [topic] }),
  ]);
  const done = new Map(
    (committed.find((t) => t.topic === topic)?.partitions ?? []).map((p) => [
      p.partition,
      Number(p.offset),
    ]),
  );
  let lag = 0;
  for (const p of end) {
    const at = done.get(p.partition);
    // no committed offset yet (-1): everything still in the log is unread
    lag += Math.max(0, Number(p.high) - (at === undefined || at < 0 ? Number(p.low) : at));
  }
  return lag;
}

/** Messages sitting in a topic (used for dead-letter topics). */
export async function measureDepth(admin: AdminLike, topic: string): Promise<number> {
  return (await admin.fetchTopicOffsets(topic)).reduce(
    (n, p) => n + Math.max(0, Number(p.high) - Number(p.low)),
    0,
  );
}

/**
 * Keeps `gatepass_consumer_lag` and `gatepass_dlq_depth` current for one consumer group. A reading
 * that fails (broker busy) is skipped; the next tick tries again.
 */
export class LagMonitor {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly admin: AdminLike,
    private readonly groupId: string,
    private readonly topics: string[],
    private readonly intervalMs = Number(process.env.LAG_INTERVAL_MS ?? 5000),
  ) {}

  async tick(): Promise<void> {
    for (const topic of this.topics) {
      try {
        metrics
          .consumerLag()
          .set({ group: this.groupId, topic }, await measureLag(this.admin, this.groupId, topic));
      } catch {
        /* skipped this round */
      }
    }
    const dlq = dlqTopicFor(this.groupId);
    try {
      metrics.dlqDepth().set({ dlq }, await measureDepth(this.admin, dlq));
    } catch {
      /* the dead-letter topic may not exist yet */
    }
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
