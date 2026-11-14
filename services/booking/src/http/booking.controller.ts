import {
  BadRequestException,
  Body,
  ForbiddenException,
  HttpCode,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { approveRefund } from '../refunds';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  createBooking,
  getBooking,
  type CreateBookingInput,
} from '../bookings';

export const POOL = Symbol('POOL');

/** Internal API. Only the gateway calls it; the gateway supplies the authenticated userId. */
@Controller()
export class BookingController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'booking' };
  }

  @Post('bookings')
  async create(@Body() body: CreateBookingInput) {
    try {
      return await createBooking(this.pool, {
        eventId: body?.eventId,
        userId: body?.userId,
        seatIds: body?.seatIds,
      });
    } catch (err) {
      if (err instanceof ValidationError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Get('bookings/:id')
  async get(@Param('id') id: string) {
    try {
      return await getBooking(this.pool, id);
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundException(err.message);
      throw err;
    }
  }

  /** The organizer approves a refund (organizer id from the verified token, via the gateway). */
  @Post('refunds/:id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() body: { organizerId?: string }) {
    if (!body?.organizerId) throw new BadRequestException('organizerId is required');
    try {
      return await approveRefund(this.pool, id, body.organizerId);
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundException(err.message);
      if (err instanceof ForbiddenError) throw new ForbiddenException(err.message);
      throw err;
    }
  }
}
