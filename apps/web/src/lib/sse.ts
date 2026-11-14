import { getSession } from './session';

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * Parses as much of a Server-Sent Events byte stream as is complete and returns the rest.
 * (EventSource cannot send an Authorization header, and we never put tokens in URLs, so the app
 * reads the stream itself with fetch.)
 */
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  const messages: SseMessage[] = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
    if (data.length) messages.push({ event, data: data.join('\n'), id });
  }
  return { messages, rest };
}

export interface StreamOptions<T> {
  /** Called for each JSON message (named events like `ping` are ignored). */
  onMessage: (message: T) => void;
  /** open | reconnecting | closed */
  onStatus?: (status: 'open' | 'reconnecting') => void;
  auth?: boolean;
  /** Called when the server refuses the stream (401/403/404): no retry makes sense. */
  onRefused?: (status: number) => void;
  signal?: AbortSignal;
}

/** Opens a stream and keeps it open (reconnecting with backoff) until `signal` aborts. */
export async function openStream<T>(path: string, opts: StreamOptions<T>): Promise<void> {
  let delay = 500;
  while (!opts.signal?.aborted) {
    try {
      const headers: Record<string, string> = { accept: 'text/event-stream' };
      if (opts.auth !== false) {
        const s = getSession();
        if (s) headers.authorization = `Bearer ${s.token}`;
      }
      const res = await fetch(path, { headers, signal: opts.signal });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        opts.onRefused?.(res.status);
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream answered ${res.status}`);

      opts.onStatus?.('open');
      delay = 500;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const m of parsed.messages) {
          if (m.event !== 'message') continue; // `ping` heartbeats
          try {
            opts.onMessage(JSON.parse(m.data) as T);
          } catch {
            /* a malformed message is skipped, never fatal */
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError' || opts.signal?.aborted) return;
    }
    if (opts.signal?.aborted) return;
    opts.onStatus?.('reconnecting');
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 10_000);
  }
}
