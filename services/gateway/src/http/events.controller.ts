import { Controller, Get, Inject, Param, Sse, type MessageEvent } from '@nestjs/common';
import { interval, map, merge, type Observable } from 'rxjs';
import type { CatalogClient, InventoryClient } from '../clients/clients';
import { SeatStreamHub } from '../seat-stream/seat-stream';
import { relay } from './downstream';

export const CATALOG = Symbol('CATALOG');
export const INVENTORY = Symbol('INVENTORY');
export const HEARTBEAT_MS = Symbol('HEARTBEAT_MS');

export type SalesStatus = 'sold_out' | 'selling_fast' | 'available' | 'unavailable';

/** "Selling fast" once 40% or fewer of the seats are left. */
export const SELLING_FAST_RATIO = 0.4;

export function salesStatus(total: number, available: number): SalesStatus {
  if (total === 0) return 'unavailable'; // seats not created yet
  if (available === 0) return 'sold_out';
  return available / total <= SELLING_FAST_RATIO ? 'selling_fast' : 'available';
}

@Controller('api')
export class EventsController {
  constructor(
    @Inject(CATALOG) private readonly catalog: CatalogClient,
    @Inject(INVENTORY) private readonly inventory: InventoryClient,
    private readonly hub: SeatStreamHub,
    @Inject(HEARTBEAT_MS) private readonly heartbeatMs: number,
  ) {}

  /** The show list: catalog data plus live availability from the seat-inventory read model. */
  @Get('events')
  async list() {
    const events = await relay(() => this.catalog.listEvents());
    const counts = await relay(() => this.inventory.getAvailability(events.map((e) => e.id)));
    const byEvent = new Map(counts.map((c) => [c.eventId, c]));
    return events.map((e) => {
      const c = byEvent.get(e.id) ?? { total: 0, available: 0 };
      return {
        id: e.id,
        title: e.title,
        category: e.category,
        venue: e.venue,
        startsAt: e.startsAt,
        currency: e.currency,
        waitingRoom: e.waitingRoom,
        minPrice: e.minPriceMinor / 100, // major units, as the UI shows "From ₹1,200"
        status: salesStatus(c.total, c.available),
        availability: { total: c.total, available: c.available },
      };
    });
  }

  @Get('events/:id/seats')
  seats(@Param('id') id: string) {
    return relay(() => this.inventory.getSeats(id));
  }

  /** Live seat changes: `{seatId, state}` per message. A ping keeps proxies from closing the stream. */
  @Sse('events/:id/seats/stream')
  stream(@Param('id') id: string): Observable<MessageEvent> {
    const updates = this.hub
      .stream(id)
      .pipe(map((u): MessageEvent => ({ data: { seatId: u.seatId, state: u.state } })));
    const ping = interval(this.heartbeatMs).pipe(
      map((): MessageEvent => ({ type: 'ping', data: {} })),
    );
    return merge(updates, ping);
  }
}
