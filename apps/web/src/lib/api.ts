import { getSession } from './session';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** The request never reached the server, or the server was unreachable. */
  get offline(): boolean {
    return this.status === 0;
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send the signed-in user's token. Default true. */
  auth?: boolean;
  signal?: AbortSignal;
}

/** Calls the gateway through the same-origin /api proxy. Throws ApiError for anything but 2xx. */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth !== false) {
    const s = getSession();
    if (s) headers.authorization = `Bearer ${s.token}`;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'Could not reach the server');
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const b = (json ?? {}) as { message?: string | string[]; code?: string };
    const message = Array.isArray(b.message) ? b.message.join(', ') : (b.message ?? res.statusText);
    throw new ApiError(res.status, message, b.code, json);
  }
  return json as T;
}

// ---------------------------------------------------------------------------- types (the gateway's)

export interface EventListItem {
  id: string;
  title: string;
  category: string;
  venue: string;
  startsAt: string;
  currency: string;
  waitingRoom: boolean;
  minPrice: number;
  status: 'sold_out' | 'selling_fast' | 'available' | 'unavailable';
  availability: { total: number; available: number };
}

export interface Seat {
  id: string;
  row: string;
  number: number;
  tier: string;
  price: number;
  state: 'available' | 'held' | 'taken';
}

export interface Booking {
  id: string;
  eventId: string;
  userId: string;
  seatIds: string[];
  state: 'REQUESTED' | 'HELD' | 'PAID' | 'CONFIRMED' | 'CANCELLED';
  holdExpiresAt: string | null;
  cancelReason: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  serverTime: string;
}

export interface Ticket {
  id: string;
  code: string;
  bookingId: string;
  eventId: string;
  eventTitle: string;
  startsAt: string;
  venue: string;
  row: string;
  seat: string;
  tier: string;
  qrToken: string;
  status: 'valid' | 'used' | 'refund_requested' | 'void';
}

export interface OrganizerSummary {
  eventId: string;
  title: string;
  startsAt: string;
  sold: number;
  total: number;
  held: number;
  left: number;
  refundRequests: number;
  tiers: { name: string; sold: number; total: number }[];
}

export interface RefundItem {
  id: string;
  bookingId: string;
  userId: string;
  seatId: string;
  amountMinor: number;
  currency: string;
  state: 'requested' | 'approved' | 'completed';
}

export interface ActivityItem {
  id: string;
  eventId: string;
  bookingId: string;
  type: string;
  text: string;
  failed: boolean;
  at: string;
}

export type WaitingRoomView =
  | { state: 'waiting'; position: number; estimatedWaitSeconds: number }
  | { state: 'admitted'; admissionToken: string; expiresInSeconds: number }
  | { state: 'not_queued' };

export type CheckInResult =
  | { status: 'valid'; row: string; seat: string; tier: string }
  | { status: 'used'; usedAt: string }
  | { status: 'invalid' };
