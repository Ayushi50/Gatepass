import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { v7 as uuidv7, validate as isUuid } from 'uuid';
import { EVENT_CATALOG, isEventType, type EventType } from './catalog';
import { EventEnvelopeSchema, type EventEnvelope } from './gen/gatepass/events/v1/events_pb';

export class InvalidEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnvelopeError';
  }
}

export interface BuildEnvelopeInput<T extends EventType> {
  eventType: T;
  payload: MessageInitShape<(typeof EVENT_CATALOG)[T]['schema']>;
  /** The booking ID. Required on every event so one booking can be followed across services. */
  correlationId: string;
  /** eventId of the event that caused this one; omit for a root event. */
  causationId?: string;
  /** Emitting service name, e.g. "seat-inventory". */
  producer: string;
  version?: number;
  /** Injectable for tests. */
  eventId?: string;
  now?: () => number;
}

/** Builds a validated envelope. Throws InvalidEnvelopeError if a required field is missing. */
export function buildEnvelope<T extends EventType>(input: BuildEnvelopeInput<T>): EventEnvelope {
  const entry = EVENT_CATALOG[input.eventType];
  if (!entry) throw new InvalidEnvelopeError(`unknown eventType "${String(input.eventType)}"`);

  const payload = create(entry.schema, input.payload as never);
  const envelope = create(EventEnvelopeSchema, {
    eventId: input.eventId ?? uuidv7(),
    eventType: input.eventType,
    version: input.version ?? 1,
    occurredAtMs: BigInt((input.now ?? Date.now)()),
    correlationId: input.correlationId,
    causationId: input.causationId ?? '',
    producer: input.producer,
    payload: { case: entry.case, value: payload } as EventEnvelope['payload'],
  });
  validateEnvelope(envelope);
  return envelope;
}

/** Throws InvalidEnvelopeError unless the envelope is complete and internally consistent. */
export function validateEnvelope(envelope: EventEnvelope): void {
  if (!isUuid(envelope.eventId)) throw new InvalidEnvelopeError('eventId must be a UUID');
  if (!isEventType(envelope.eventType)) {
    throw new InvalidEnvelopeError(`unknown eventType "${envelope.eventType}"`);
  }
  if (envelope.version < 1) throw new InvalidEnvelopeError('version must be >= 1');
  if (envelope.occurredAtMs <= 0n) throw new InvalidEnvelopeError('occurredAt must be set');
  if (!envelope.correlationId) throw new InvalidEnvelopeError('correlationId is required');
  if (!envelope.producer) throw new InvalidEnvelopeError('producer is required');
  if (envelope.payload.case !== EVENT_CATALOG[envelope.eventType].case) {
    throw new InvalidEnvelopeError(
      `payload "${String(envelope.payload.case)}" does not match eventType "${envelope.eventType}"`,
    );
  }
}

export function encodeEnvelope(envelope: EventEnvelope): Uint8Array {
  validateEnvelope(envelope);
  return toBinary(EventEnvelopeSchema, envelope);
}

/** Decodes and validates. Throws InvalidEnvelopeError for anything that is not a valid envelope. */
export function decodeEnvelope(bytes: Uint8Array): EventEnvelope {
  let envelope: EventEnvelope;
  try {
    envelope = fromBinary(EventEnvelopeSchema, bytes);
  } catch (err) {
    throw new InvalidEnvelopeError(`cannot decode envelope: ${(err as Error).message}`);
  }
  validateEnvelope(envelope);
  return envelope;
}

/** Headers that travel beside the body so consumers can route/trace without decoding it. */
export function envelopeHeaders(envelope: EventEnvelope): Record<string, string> {
  return {
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    correlationId: envelope.correlationId,
    producer: envelope.producer,
  };
}
