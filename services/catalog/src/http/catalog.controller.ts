import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import type { Pool } from 'pg';
import { NotFoundError, getEvent, listEvents } from '../events';

export const POOL = Symbol('POOL');

/** Internal API. Only the gateway calls it. */
@Controller()
export class CatalogController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'catalog' };
  }

  @Get('events')
  list() {
    return listEvents(this.pool);
  }

  @Get('events/:id')
  async get(@Param('id') id: string) {
    try {
      return await getEvent(this.pool, id);
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundException(err.message);
      throw err;
    }
  }
}
