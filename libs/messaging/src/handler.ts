import { decodeEnvelope, type EventEnvelope } from '@gatepass/events';
import {
  DEFAULT_RETRY_POLICY,
  RetriesExhaustedError,
  runWithRetry,
  type RetryDeps,
  type RetryPolicy,
} from './retry';

/** A message as delivered by the broker, independent of the Kafka client library. */
export interface IncomingMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: Uint8Array | null;
  headers: Record<string, string>;
}

/** Where messages go when they cannot be processed. One DLQ topic per consumer group. */
export interface DeadLetterPublisher {
  publish(
    topic: string,
    message: { key: string | null; value: Uint8Array | null; headers: Record<string, string> },
  ): Promise<void>;
}

export const dlqTopicFor = (groupId: string): string => `${groupId}.dlq`;

export type HandleOutcome = 'handled' | 'dead-lettered';

export interface MessageHandlerOptions {
  groupId: string;
  handle: (envelope: EventEnvelope, message: IncomingMessage) => Promise<void>;
  dlq: DeadLetterPublisher;
  retry?: RetryPolicy;
  retryDeps?: RetryDeps;
}

/**
 * Builds the per-message pipeline used by every consumer:
 *   decode -> handle (retry with backoff) -> on exhaustion, publish to `<group>.dlq`.
 *
 * - An undecodable message is a poison pill: it goes to the DLQ at once (retrying cannot help).
 * - If the DLQ publish itself fails, this throws, so the client does NOT commit the offset and
 *   the message is redelivered. A message is never silently dropped.
 */
export function createMessageHandler(opts: MessageHandlerOptions) {
  const policy = opts.retry ?? DEFAULT_RETRY_POLICY;
  const dlqTopic = dlqTopicFor(opts.groupId);

  const deadLetter = async (message: IncomingMessage, error: unknown, attempts: number) => {
    await opts.dlq.publish(dlqTopic, {
      key: message.key,
      value: message.value,
      headers: {
        ...message.headers,
        'x-dlq-original-topic': message.topic,
        'x-dlq-original-partition': String(message.partition),
        'x-dlq-original-offset': message.offset,
        'x-dlq-consumer': opts.groupId,
        'x-dlq-attempts': String(attempts),
        'x-dlq-error': String((error as Error)?.message ?? error).slice(0, 500),
        'x-dlq-failed-at': new Date().toISOString(),
      },
    });
  };

  return async (message: IncomingMessage): Promise<HandleOutcome> => {
    let envelope: EventEnvelope;
    try {
      if (!message.value) throw new Error('empty message value');
      envelope = decodeEnvelope(message.value);
    } catch (error) {
      await deadLetter(message, error, 0);
      return 'dead-lettered';
    }

    try {
      await runWithRetry(() => opts.handle(envelope, message), policy, opts.retryDeps);
      return 'handled';
    } catch (error) {
      const attempts = error instanceof RetriesExhaustedError ? error.attempts : 1;
      await deadLetter(message, error, attempts);
      return 'dead-lettered';
    }
  };
}
