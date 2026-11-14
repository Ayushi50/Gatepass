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
  waitingRoom: boolean;
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
  amountMinor?: number | null;
  currency?: string | null;
  serverTime: string;
}

export interface PaymentView {
  paymentId: string;
  status: 'created' | 'processing' | 'succeeded' | 'failed';
}

export interface TicketView {
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
  status: 'valid' | 'used';
}

/** The ticket service's answer to a scan. `httpStatus` is 200 valid, 409 used, 404 invalid. */
export interface CheckInResponse {
  httpStatus: 200 | 404 | 409;
  body: { status: 'valid' | 'used' | 'invalid'; [k: string]: unknown };
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

export interface CatalogClient {
  listEvents(): Promise<EventSummary[]>;
  getEvent(id: string): Promise<EventSummary>;
}
export interface InventoryClient {
  getSeats(eventId: string): Promise<SeatView[]>;
  getAvailability(eventIds: string[]): Promise<Availability[]>;
}
export interface PaymentClient {
  pay(input: {
    bookingId: string;
    userId: string;
    method: string;
    token: string;
    idempotencyKey: string;
  }): Promise<PaymentView>;
}
export interface TicketClient {
  list(userId: string): Promise<TicketView[]>;
  forBooking(bookingId: string): Promise<{ issued: boolean; count: number }>;
  checkIn(qrToken: string, staffId: string): Promise<CheckInResponse>;
  requestRefund(ticketId: string, userId: string): Promise<{ refundId: string; status: string }>;
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

export interface AnalyticsClient {
  refunds(eventId: string, organizerId: string): Promise<RefundItem[]>;
  summary(eventId: string, organizerId: string): Promise<OrganizerSummary>;
  activity(eventId: string, organizerId: string, limit?: number): Promise<ActivityItem[]>;
}
export interface BookingClient {
  create(input: { eventId: string; userId: string; seatIds: string[] }): Promise<BookingView>;
  get(id: string): Promise<BookingView>;
  approveRefund(
    refundId: string,
    organizerId: string,
  ): Promise<{ refundId: string; state: string }>;
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
  getEvent(id: string) {
    return call<EventSummary>(this.baseUrl, `/events/${encodeURIComponent(id)}`);
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
  approveRefund(refundId: string, organizerId: string) {
    return call<{ refundId: string; state: string }>(
      this.baseUrl,
      `/refunds/${encodeURIComponent(refundId)}/approve`,
      { method: 'POST', body: JSON.stringify({ organizerId }) },
    );
  }
}

export class HttpPaymentClient implements PaymentClient {
  constructor(private readonly baseUrl: string) {}
  pay(input: {
    bookingId: string;
    userId: string;
    method: string;
    token: string;
    idempotencyKey: string;
  }) {
    return call<PaymentView>(this.baseUrl, '/payments', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
}

export class HttpTicketClient implements TicketClient {
  constructor(private readonly baseUrl: string) {}
  list(userId: string) {
    return call<TicketView[]>(this.baseUrl, `/tickets?userId=${encodeURIComponent(userId)}`);
  }
  requestRefund(ticketId: string, userId: string) {
    return call<{ refundId: string; status: string }>(
      this.baseUrl,
      `/tickets/${encodeURIComponent(ticketId)}/refund`,
      { method: 'POST', body: JSON.stringify({ userId }) },
    );
  }
  forBooking(bookingId: string) {
    return call<{ issued: boolean; count: number }>(
      this.baseUrl,
      `/bookings/${encodeURIComponent(bookingId)}/tickets`,
    );
  }
  async checkIn(qrToken: string, staffId: string): Promise<CheckInResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/checkin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ qrToken, staffId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new DownstreamError(503, `service unreachable: ${(err as Error).message}`);
    }
    // 200 / 409 / 404 are all normal answers to a scan; anything else is a real failure
    if (res.status === 200 || res.status === 409 || res.status === 404) {
      return { httpStatus: res.status, body: (await res.json()) as CheckInResponse['body'] };
    }
    throw new DownstreamError(res.status === 400 ? 400 : 502, `check-in failed (${res.status})`);
  }
}

export class HttpAnalyticsClient implements AnalyticsClient {
  constructor(private readonly baseUrl: string) {}
  summary(eventId: string, organizerId: string) {
    return call<OrganizerSummary>(
      this.baseUrl,
      `/organizer/events/${encodeURIComponent(eventId)}/summary?organizerId=${encodeURIComponent(organizerId)}`,
    );
  }
  refunds(eventId: string, organizerId: string) {
    return call<RefundItem[]>(
      this.baseUrl,
      `/organizer/events/${encodeURIComponent(eventId)}/refunds?organizerId=${encodeURIComponent(organizerId)}`,
    );
  }
  activity(eventId: string, organizerId: string, limit = 20) {
    return call<ActivityItem[]>(
      this.baseUrl,
      `/organizer/events/${encodeURIComponent(eventId)}/activity?organizerId=${encodeURIComponent(organizerId)}&limit=${limit}`,
    );
  }
}
