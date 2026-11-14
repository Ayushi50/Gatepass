import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { ReplaySubject, finalize, interval, map, merge, startWith, type Observable } from 'rxjs';
import { AuthGuard, Roles, type AuthedRequest } from '../auth/auth.guard';
import type { BookingClient, PaymentClient, TicketClient } from '../clients/clients';
import { TICKETS } from './tickets.controller';
import { BookingStreamHub, type BookingUpdate } from '../seat-stream/seat-stream';
import { HEARTBEAT_MS } from './events.controller';
import { relay } from './downstream';

export const BOOKINGS = Symbol('BOOKINGS');
export const PAYMENTS = Symbol('PAYMENTS');

@Controller('api')
@UseGuards(AuthGuard)
export class BookingsController {
  constructor(
    @Inject(BOOKINGS) private readonly bookings: BookingClient,
    @Inject(PAYMENTS) private readonly payments: PaymentClient,
    @Inject(TICKETS) private readonly tickets: TicketClient,
    private readonly bookingHub: BookingStreamHub,
    @Inject(HEARTBEAT_MS) private readonly heartbeatMs: number,
  ) {}

  private async ticketsIssued(bookingId: string): Promise<boolean> {
    try {
      return (await this.tickets.forBooking(bookingId)).issued;
    } catch {
      return false; // the live `ticket.issued` event will still turn the light on
    }
  }

  private async ownedBooking(userId: string, id: string) {
    const booking = await relay(() => this.bookings.get(id));
    if (booking.userId !== userId) throw new ForbiddenException('not your booking');
    return booking;
  }

  /**
   * Starts a booking. The user comes from the verified token, never from the request body,
   * so a client cannot book as someone else.
   */
  @Post('bookings')
  @Roles('attendee')
  create(@Req() req: AuthedRequest, @Body() body: { eventId?: string; seatIds?: string[] }) {
    return relay(() =>
      this.bookings.create({
        eventId: body?.eventId as string,
        seatIds: body?.seatIds as string[],
        userId: req.user!.sub,
      }),
    );
  }

  /** Includes `holdExpiresAt` and `serverTime`, both server clock. */
  @Get('bookings/:id')
  @Roles('attendee')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.ownedBooking(req.user!.sub, id);
  }

  /**
   * Pays for a held booking. `Idempotency-Key` is required: retrying with the same key (a
   * double click, a network retry) returns the same payment instead of charging twice. The
   * body carries only the method and an opaque provider token, never raw card details.
   * The result arrives asynchronously (webhook), so this answers 202; watch the stream.
   */
  @Post('bookings/:id/pay')
  @Roles('attendee')
  @HttpCode(202)
  async pay(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: { method?: string; token?: string },
  ) {
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
    await this.ownedBooking(req.user!.sub, id);
    return relay(() =>
      this.payments.pay({
        bookingId: id,
        userId: req.user!.sub,
        method: body?.method as string,
        token: body?.token as string,
        idempotencyKey,
      }),
    );
  }

  /**
   * Live progress of one booking for the status page. The first message is a snapshot of the
   * booking (`kind: "snapshot"`), then one message per step (`kind: "event"`). Lights only ever
   * turn on, so a step seen both in the snapshot and live is harmless.
   *
   * The hub is subscribed BEFORE the snapshot is read and buffered, so a step that happens
   * in between is not lost. Auth is the Authorization header (the browser uses a fetch-based
   * stream rather than EventSource), so no token ever appears in a URL.
   */
  @Sse('bookings/:id/stream')
  @Roles('attendee')
  async stream(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<Observable<MessageEvent>> {
    const buffer = new ReplaySubject<BookingUpdate>();
    const subscription = this.bookingHub.stream(id).subscribe(buffer);
    let snapshot: MessageEvent;
    try {
      const b = await this.ownedBooking(req.user!.sub, id);
      snapshot = {
        data: {
          kind: 'snapshot',
          state: b.state,
          holdExpiresAt: b.holdExpiresAt,
          cancelReason: b.cancelReason,
          serverTime: b.serverTime,
          // the third light: only a confirmed booking can have tickets
          ticketsIssued: b.state === 'CONFIRMED' ? await this.ticketsIssued(id) : false,
        },
      };
    } catch (err) {
      subscription.unsubscribe();
      throw err;
    }
    const live = buffer.pipe(
      map((u): MessageEvent => ({
        data: { kind: 'event', type: u.type, reason: u.reason, at: u.at },
      })),
    );
    const ping = interval(this.heartbeatMs).pipe(
      map((): MessageEvent => ({ type: 'ping', data: {} })),
    );
    return merge(live, ping).pipe(
      startWith(snapshot),
      finalize(() => subscription.unsubscribe()),
    );
  }
}
