import { encodeEnvelope, type EventEnvelope } from '@gatepass/events';
import { currentTraceparent } from '@gatepass/telemetry';
import type { Queryable } from './db';

/**
 * Appends an event to the outbox using the CALLER'S transaction.
 *
 * This is the only way a service emits an event. It deliberately takes the caller's
 * `tx` instead of opening its own, so the business write and the event commit or roll back
 * together. It never talks to Kafka.
 */
export async function appendToOutbox(
  tx: Queryable,
  envelope: EventEnvelope,
  aggregateId: string,
): Promise<void> {
  const body = Buffer.from(encodeEnvelope(envelope));
  const traceparent = currentTraceparent();
  await tx.query(
    `INSERT INTO outbox
       (event_id, event_type, aggregate_id, correlation_id, causation_id, version, payload, headers)
     VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8)`,
    [
      envelope.eventId,
      envelope.eventType,
      aggregateId,
      envelope.correlationId,
      envelope.causationId,
      envelope.version,
      body,
      // The trace context goes into the row, not onto a call: the relay may publish this event
      // later, from another process, and the trace must still continue from here.
      JSON.stringify(traceparent ? { traceparent } : {}),
    ],
  );
}
