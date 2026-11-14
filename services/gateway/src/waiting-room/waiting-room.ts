import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * The waiting room for high-demand shows: a first-come-first-served queue per event in a Redis
 * sorted set, drained at a configurable rate by an admitter. Being admitted is a short-lived Redis
 * key; the booking endpoint requires it. All multi-step changes are Lua scripts, so they are atomic.
 *
 * Keys (per event E, user U):  wr:E:q (queue, scored by arrival number)  wr:E:seq (arrival counter)
 *                              wr:E:a:U (admitted, with TTL)  wr:events (events with a queue)
 *                              wr:leader (which gateway instance is admitting)
 */
export interface WaitingRoomOptions {
  /** People let in per second, per event. */
  admitPerSecond: number;
  /** How long an admission lasts, in seconds. */
  admissionTtlSeconds: number;
}

export type WaitingRoomStatus =
  | { state: 'waiting'; position: number; estimatedWaitSeconds: number }
  | { state: 'admitted'; expiresInSeconds: number }
  | { state: 'not_queued' };

const JOIN = `
if redis.call('EXISTS', KEYS[3]) == 1 then return -1 end
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], redis.call('INCR', KEYS[2]), ARGV[1])
end
redis.call('SADD', KEYS[4], ARGV[2])
return redis.call('ZRANK', KEYS[1], ARGV[1]) + 1`;

// ARGV: count, admitted-key prefix, ttl seconds, event id
const ADMIT = `
local popped = redis.call('ZPOPMIN', KEYS[1], ARGV[1])
local users = {}
for i = 1, #popped, 2 do
  redis.call('SET', ARGV[2] .. popped[i], '1', 'EX', ARGV[3])
  users[#users + 1] = popped[i]
end
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('SREM', KEYS[2], ARGV[4]) end
return users`;

// become (or stay) the admitter: ARGV = instance id, lease in ms
const LEAD = `
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end
if not cur then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0`;

const k = {
  queue: (e: string) => `wr:${e}:q`,
  seq: (e: string) => `wr:${e}:seq`,
  admittedPrefix: (e: string) => `wr:${e}:a:`,
  admitted: (e: string, u: string) => `wr:${e}:a:${u}`,
  events: 'wr:events',
  leader: 'wr:leader',
};

export class WaitingRoom {
  constructor(
    private readonly redis: Redis,
    readonly opts: WaitingRoomOptions,
  ) {}

  /** Joins the queue (or reports the place already held). Safe to call repeatedly. */
  async join(eventId: string, userId: string): Promise<WaitingRoomStatus> {
    const rank = (await this.redis.eval(
      JOIN,
      4,
      k.queue(eventId),
      k.seq(eventId),
      k.admitted(eventId, userId),
      k.events,
      userId,
      eventId,
    )) as number;
    if (rank === -1) return this.status(eventId, userId);
    return this.waiting(rank);
  }

  async status(eventId: string, userId: string): Promise<WaitingRoomStatus> {
    const ttlMs = await this.redis.pttl(k.admitted(eventId, userId));
    if (ttlMs > 0) return { state: 'admitted', expiresInSeconds: Math.ceil(ttlMs / 1000) };
    const rank = await this.redis.zrank(k.queue(eventId), userId);
    return rank === null ? { state: 'not_queued' } : this.waiting(rank + 1);
  }

  async isAdmitted(eventId: string, userId: string): Promise<boolean> {
    return (await this.redis.exists(k.admitted(eventId, userId))) === 1;
  }

  async queueLength(eventId: string): Promise<number> {
    return this.redis.zcard(k.queue(eventId));
  }

  async activeEvents(): Promise<string[]> {
    return this.redis.smembers(k.events);
  }

  /** Lets the next `count` people in, in arrival order. Returns who was admitted. */
  async admit(eventId: string, count: number): Promise<string[]> {
    if (count <= 0) return [];
    return (await this.redis.eval(
      ADMIT,
      2,
      k.queue(eventId),
      k.events,
      String(count),
      k.admittedPrefix(eventId),
      String(this.opts.admissionTtlSeconds),
      eventId,
    )) as string[];
  }

  /** Try to be (or remain) the one instance that admits. */
  async lead(instanceId: string, leaseMs: number): Promise<boolean> {
    return (await this.redis.eval(LEAD, 1, k.leader, instanceId, String(leaseMs))) === 1;
  }

  private waiting(position: number): WaitingRoomStatus {
    return {
      state: 'waiting',
      position,
      estimatedWaitSeconds: Math.ceil(position / this.opts.admitPerSecond),
    };
  }
}

/**
 * Admits people at `admitPerSecond`. Several gateway instances may run one; a lease in Redis lets
 * exactly one of them admit at a time, so the configured rate is never doubled. Fractional rates
 * are handled with a per-event credit that accrues with elapsed time.
 */
export class WaitingRoomAdmitter {
  readonly id = randomUUID();
  private readonly credit = new Map<string, number>();
  private lastTick: number | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly room: WaitingRoom,
    private readonly opts: {
      tickMs?: number;
      now?: () => number;
      onError?: (e: unknown) => void;
    } = {},
  ) {}

  /** One admission step. Returns how many people were let in (0 if this instance is not the leader). */
  async tick(): Promise<number> {
    const now = (this.opts.now ?? Date.now)();
    const tickMs = this.opts.tickMs ?? 250;
    if (!(await this.room.lead(this.id, tickMs * 4))) {
      this.lastTick = undefined; // not leading: start fresh if we become leader later
      return 0;
    }
    const elapsed = this.lastTick === undefined ? tickMs : Math.min(now - this.lastTick, 5000);
    this.lastTick = now;

    const rate = this.room.opts.admitPerSecond;
    let admitted = 0;
    for (const eventId of await this.room.activeEvents()) {
      // credit builds up, but never beyond one second's worth, so a quiet spell is not a burst
      const credit = Math.min((this.credit.get(eventId) ?? 0) + (rate * elapsed) / 1000, rate);
      const n = Math.floor(credit);
      const let_in = n > 0 ? (await this.room.admit(eventId, n)).length : 0;
      this.credit.set(eventId, credit - n);
      admitted += let_in;
    }
    return admitted;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick().catch((e) => this.opts.onError?.(e)),
      this.opts.tickMs ?? 250,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
