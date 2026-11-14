import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Pool } from 'pg';
import type { QrKeyRing } from '../qr-token';
import { checkIn, listTickets, ticketsForBooking } from '../tickets';

export const POOL = Symbol('POOL');
export const KEYS = Symbol('KEYS');

/** Internal API. Only the gateway calls it, with the user / staff id from the verified token. */
@Controller()
export class TicketController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(KEYS) private readonly keys: QrKeyRing,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'ticket' };
  }

  @Get('tickets')
  list(@Query('userId') userId?: string) {
    if (!userId) throw new BadRequestException('userId is required');
    return listTickets(this.pool, this.keys, userId);
  }

  @Get('bookings/:id/tickets')
  forBooking(@Param('id') id: string) {
    return ticketsForBooking(this.pool, id);
  }

  /** 200 valid, 409 used (with usedAt), 404 invalid. Safe to call concurrently from many gates. */
  @Post('checkin')
  @HttpCode(200)
  async checkIn(@Body() body: { qrToken?: string; staffId?: string }) {
    if (!body?.qrToken || !body?.staffId)
      throw new BadRequestException('qrToken and staffId are required');
    const result = await checkIn(this.pool, this.keys, body.qrToken, body.staffId);
    if (result.status === 'used') throw new ConflictException(result);
    if (result.status === 'invalid') throw new NotFoundException(result);
    return result;
  }
}
