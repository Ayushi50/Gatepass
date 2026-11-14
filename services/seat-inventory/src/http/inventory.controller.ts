import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { getAvailability, getSeats } from '../queries';

export const POOL = Symbol('POOL');

/** Internal API. Only the gateway calls it. */
@Controller()
export class InventoryController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'seat-inventory' };
  }

  @Get('events/:id/seats')
  async seats(@Param('id') id: string) {
    const seats = await getSeats(this.pool, id);
    if (seats.length === 0) throw new NotFoundException(`no seats for event ${id}`);
    return seats;
  }

  @Get('availability')
  availability(@Query('eventIds') eventIds = '') {
    return getAvailability(this.pool, eventIds.split(',').filter(Boolean));
  }
}
