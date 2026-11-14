/**
 * The gateway talks to services only through these interfaces (plain HTTP in production,
 * fakes in tests). This is the one place synchronous service calls are allowed (rule 8).
 */
export class DownstreamError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DownstreamError';
  }
}

export interface EventSummary {
  id: string;
  title: string;
  category: string;
  venue: string;
  startsAt: string;
  currency: string;
  minPriceMinor: number;
  tiers: { name: string; priceMinor: number; seatCount: number }[];
}

export interface SeatView {
  id: string;
  row: string;
  number: number;
  tier: string;
  price: number;
  state: 'available' | 'held' | 'taken';
}

export interface Availability {
  eventId: string;
  total: number;
  available: number;
}

export interface BookingView {
  id: string;
  eventId: string;
  userId: string;
  seatIds: string[];
  state: string;
  holdExpiresAt: string | null;
  cancelReason: string | null;
  serverTime: string;
}

export interface CatalogClient {
  listEvents(): Promise<EventSummary[]>;
}
export interface InventoryClient {
  getSeats(eventId: string): Promise<SeatView[]>;
  getAvailability(eventIds: string[]): Promise<Availability[]>;
}
export interface BookingClient {
  create(input: { eventId: string; userId: string; seatIds: string[] }): Promise<BookingView>;
  get(id: string): Promise<BookingView>;
}

async function call<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new DownstreamError(503, `service unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      message = Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? message);
    } catch {
      // keep statusText
    }
    throw new DownstreamError(res.status, message);
  }
  return (await res.json()) as T;
}

export class HttpCatalogClient implements CatalogClient {
  constructor(private readonly baseUrl: string) {}
  listEvents() {
    return call<EventSummary[]>(this.baseUrl, '/events');
  }
}

export class HttpInventoryClient implements InventoryClient {
  constructor(private readonly baseUrl: string) {}
  getSeats(eventId: string) {
    return call<SeatView[]>(this.baseUrl, `/events/${encodeURIComponent(eventId)}/seats`);
  }
  getAvailability(eventIds: string[]) {
    return call<Availability[]>(
      this.baseUrl,
      `/availability?eventIds=${encodeURIComponent(eventIds.join(','))}`,
    );
  }
}

export class HttpBookingClient implements BookingClient {
  constructor(private readonly baseUrl: string) {}
  create(input: { eventId: string; userId: string; seatIds: string[] }) {
    return call<BookingView>(this.baseUrl, '/bookings', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  get(id: string) {
    return call<BookingView>(this.baseUrl, `/bookings/${encodeURIComponent(id)}`);
  }
}
