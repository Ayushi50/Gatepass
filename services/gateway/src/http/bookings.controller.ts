import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Roles, type AuthedRequest } from '../auth/auth.guard';
import type { BookingClient } from '../clients/clients';
import { relay } from './downstream';

export const BOOKINGS = Symbol('BOOKINGS');

@Controller('api')
@UseGuards(AuthGuard)
export class BookingsController {
  constructor(@Inject(BOOKINGS) private readonly bookings: BookingClient) {}

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
  async get(@Req() req: AuthedRequest, @Param('id') id: string) {
    const booking = await relay(() => this.bookings.get(id));
    if (booking.userId !== req.user!.sub) throw new ForbiddenException('not your booking');
    return booking;
  }
}
