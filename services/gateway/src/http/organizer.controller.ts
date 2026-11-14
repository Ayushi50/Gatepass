import {
  Controller,
  Get,
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
import type { ActivityItem, AnalyticsClient, BookingClient } from '../clients/clients';
import { BOOKINGS } from './bookings.controller';
import { ActivityStreamHub } from '../seat-stream/seat-stream';
import { relay } from './downstream';
import { HEARTBEAT_MS } from './events.controller';

export const ANALYTICS = Symbol('ANALYTICS');

/** Organizer dashboard. Every call is scoped to the organizer in the token. */
@Controller('api')
@UseGuards(AuthGuard)
export class OrganizerController {
  constructor(
    @Inject(ANALYTICS) private readonly analytics: AnalyticsClient,
    @Inject(BOOKINGS) private readonly bookings: BookingClient,
    private readonly activityHub: ActivityStreamHub,
    @Inject(HEARTBEAT_MS) private readonly heartbeatMs: number,
  ) {}

  /** The tiles and tier bars: sold, held, left, and sold/total per tier. */
  @Get('organizer/events/:id/summary')
  @Roles('organizer')
  summary(@Req() req: AuthedRequest, @Param('id') id: string) {
    return relay(() => this.analytics.summary(id, req.user!.sub));
  }

  /** The "Refund requests" list: open requests first, with who, which seat and how much. */
  @Get('organizer/events/:id/refunds')
  @Roles('organizer')
  refunds(@Req() req: AuthedRequest, @Param('id') id: string) {
    return relay(() => this.analytics.refunds(id, req.user!.sub));
  }

  /**
   * The organizer approves a refund. Only the organizer of that show may; approving again is
   * harmless and just reports the current state.
   */
  @Post('refunds/:id/approve')
  @Roles('organizer')
  @HttpCode(200)
  approveRefund(@Req() req: AuthedRequest, @Param('id') id: string) {
    return relay(() => this.bookings.approveRefund(id, req.user!.sub));
  }

  /**
   * The "Live activity" feed. First message: a snapshot of the latest lines (newest first).
   * Then one message per new line, bridged from Kafka. Each line has an `id` so a client can
   * drop one it already has from the snapshot. The hub is subscribed BEFORE the snapshot is
   * read and buffered, so nothing is lost in between.
   */
  @Sse('organizer/events/:id/activity')
  @Roles('organizer')
  async activity(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<Observable<MessageEvent>> {
    const buffer = new ReplaySubject<ActivityItem>();
    const subscription = this.activityHub.stream(id).subscribe(buffer);
    let snapshot: MessageEvent;
    try {
      const items = await relay(() => this.analytics.activity(id, req.user!.sub, 20));
      snapshot = { data: { kind: 'snapshot', items } };
    } catch (err) {
      subscription.unsubscribe();
      throw err;
    }
    const live = buffer.pipe(map((item): MessageEvent => ({ data: { kind: 'event', ...item } })));
    const ping = interval(this.heartbeatMs).pipe(
      map((): MessageEvent => ({ type: 'ping', data: {} })),
    );
    return merge(live, ping).pipe(
      startWith(snapshot),
      finalize(() => subscription.unsubscribe()),
    );
  }
}
