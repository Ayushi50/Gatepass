import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import {
  EVENT_CATALOG,
  EVENT_TYPES,
  InvalidEnvelopeError,
  SeatsHeldSchema,
  buildEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  envelopeHeaders,
  topicFor,
  EventEnvelopeSchema,
} from '../src';

const base = {
  eventType: 'seats.held' as const,
  payload: { bookingId: 'b-1', eventId: 'e-1', seatIds: ['A1', 'A2'], holdExpiresAtMs: 1000n },
  correlationId: 'b-1',
  producer: 'seat-inventory',
};

describe('event envelope', () => {
  it('round-trips through the wire format', () => {
    const built = buildEnvelope({ ...base, causationId: 'c-1', now: () => 1_700_000_000_000 });
    const decoded = decodeEnvelope(encodeEnvelope(built));

    expect(decoded.eventType).toBe('seats.held');
    expect(decoded.version).toBe(1);
    expect(decoded.occurredAtMs).toBe(1_700_000_000_000n);
    expect(decoded.correlationId).toBe('b-1');
    expect(decoded.causationId).toBe('c-1');
    expect(decoded.producer).toBe('seat-inventory');
    expect(decoded.payload.case).toBe('seatsHeld');
    expect(decoded.payload.value).toMatchObject({ seatIds: ['A1', 'A2'], holdExpiresAtMs: 1000n });
  });

  it('generates a unique UUIDv7 eventId each time', () => {
    const a = buildEnvelope(base);
    const b = buildEnvelope(base);
    expect(a.eventId).not.toBe(b.eventId);
    expect(a.eventId[14]).toBe('7');
  });

  it('rejects a missing correlationId', () => {
    expect(() => buildEnvelope({ ...base, correlationId: '' })).toThrow(InvalidEnvelopeError);
  });

  it('rejects a missing producer', () => {
    expect(() => buildEnvelope({ ...base, producer: '' })).toThrow(/producer/);
  });

  it('rejects a payload that does not match the eventType', () => {
    const wrong = create(EventEnvelopeSchema, {
      ...buildEnvelope(base),
      eventType: 'seats.sold',
    });
    expect(() => encodeEnvelope(wrong)).toThrow(/does not match/);
  });

  it('rejects bytes that are not an envelope', () => {
    expect(() => decodeEnvelope(new Uint8Array([0xff, 0xff, 0xff]))).toThrow(InvalidEnvelopeError);
  });

  it('exposes routing headers', () => {
    const env = buildEnvelope(base);
    expect(envelopeHeaders(env)).toEqual({
      eventId: env.eventId,
      eventType: 'seats.held',
      correlationId: 'b-1',
      producer: 'seat-inventory',
    });
  });

  it('keeps the catalog and the proto oneof in sync', () => {
    const oneofCases = EventEnvelopeSchema.fields
      .filter((f) => f.oneof?.localName === 'payload')
      .map((f) => f.localName)
      .sort();
    const catalogCases = EVENT_TYPES.map((t) => EVENT_CATALOG[t].case).sort();
    expect(catalogCases).toEqual(oneofCases);
  });

  it('uses the event type as the topic name', () => {
    for (const t of EVENT_TYPES) expect(topicFor(t)).toBe(t);
    expect(create(SeatsHeldSchema).seatIds).toEqual([]);
  });
});

describe('infra topic list', () => {
  it('infra/redpanda/topics.txt lists exactly the catalog event types', () => {
    const file = readFileSync(join(__dirname, '../../../infra/redpanda/topics.txt'), 'utf8');
    const topics = file.split('\n').filter(Boolean).sort();
    expect(topics).toEqual([...EVENT_TYPES].sort());
  });
});
