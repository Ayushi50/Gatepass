import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStream, parseSse } from '@/lib/sse';

describe('parseSse', () => {
  it('parses complete messages and hands back the unfinished rest', () => {
    const { messages, rest } = parseSse('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
    expect(messages.map((m) => m.data)).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('data: {"c"');
  });
  it('reassembles a message split across chunks', () => {
    const first = parseSse('data: {"kind":"sna');
    expect(first.messages).toEqual([]);
    const second = parseSse(first.rest + 'pshot"}\n\n');
    expect(second.messages[0]!.data).toBe('{"kind":"snapshot"}');
  });
  it('handles CRLF, comments, ids, named events and multi-line data', () => {
    const { messages } = parseSse(
      ': hello\r\n\r\nid: 7\r\nevent: ping\r\ndata: {}\r\n\r\ndata: line1\ndata: line2\n\n',
    );
    expect(messages).toEqual([
      { event: 'ping', data: '{}', id: '7' },
      { event: 'message', data: 'line1\nline2', id: undefined },
    ]);
  });
  it('ignores a block with no data', () => {
    expect(parseSse('event: x\n\n').messages).toEqual([]);
  });
});

function stream(...chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('openStream', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('delivers JSON messages, skips heartbeats and bad JSON, and reconnects after the stream ends', async () => {
    const calls: RequestInit[] = [];
    const abort = new AbortController();
    const seen: unknown[] = [];
    const statuses: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(init);
      if (calls.length === 1)
        return stream(
          'data: {"n":1}\n\nevent: ping\ndata: {}\n\ndata: not json\n\ndata: {"n"',
          ':2}\n\n',
        );
      if (calls.length === 2) return stream('data: {"n":3}\n\n');
      abort.abort();
      return stream('');
    });
    await openStream<{ n: number }>('/s', {
      signal: abort.signal,
      onMessage: (m) => seen.push(m),
      onStatus: (s) => statuses.push(s),
    });
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(statuses).toEqual(['open', 'reconnecting', 'open', 'reconnecting', 'open']);
    expect(calls.length).toBe(3);
  });

  it('does not retry when the server refuses', async () => {
    let n = 0;
    const refused: number[] = [];
    vi.stubGlobal('fetch', async () => {
      n++;
      return new Response('no', { status: 403 });
    });
    await openStream('/s', { onMessage: () => undefined, onRefused: (s) => refused.push(s) });
    expect(n).toBe(1);
    expect(refused).toEqual([403]);
  });

  it('sends the sign-in as a header (never in the URL)', async () => {
    const tok = `${btoa('{}')}.${btoa(JSON.stringify({ sub: 'a', role: 'attendee', exp: 9_999_999_999 }))}.s`;
    window.localStorage.setItem('gp.session', tok);
    let seenHeaders: Record<string, string> = {};
    let seenUrl = '';
    const abort = new AbortController();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenHeaders = init.headers as Record<string, string>;
      abort.abort();
      return stream('');
    });
    await openStream('/api/bookings/b1/stream', {
      signal: abort.signal,
      onMessage: () => undefined,
    });
    expect(seenHeaders.authorization).toBe(`Bearer ${tok}`);
    expect(seenUrl).toBe('/api/bookings/b1/stream');
    expect(seenUrl).not.toContain(tok);
    window.localStorage.clear();
  });

  it('stops promptly when aborted while waiting to reconnect', async () => {
    const abort = new AbortController();
    vi.stubGlobal('fetch', async () => {
      setTimeout(() => abort.abort(), 20);
      return stream('');
    });
    const t0 = Date.now();
    await openStream('/s', { signal: abort.signal, onMessage: () => undefined });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
