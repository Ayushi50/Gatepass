import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { ForbiddenError, NotFoundError, getActivity, getSummary } from '../queries';

export const POOL = Symbol('POOL');

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundException(err.message);
    if (err instanceof ForbiddenError) throw new ForbiddenException(err.message);
    throw err;
  }
}

/** Internal API. Only the gateway calls it, with the organizer id from the verified token. */
@Controller()
export class AnalyticsController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'analytics' };
  }

  @Get('organizer/events/:id/summary')
  summary(@Param('id') id: string, @Query('organizerId') organizerId?: string) {
    if (!organizerId) throw new BadRequestException('organizerId is required');
    return guard(() => getSummary(this.pool, id, organizerId));
  }

  @Get('organizer/events/:id/activity')
  activity(
    @Param('id') id: string,
    @Query('organizerId') organizerId?: string,
    @Query('limit') limit?: string,
  ) {
    if (!organizerId) throw new BadRequestException('organizerId is required');
    return guard(() => getActivity(this.pool, id, organizerId, limit ? Number(limit) || 20 : 20));
  }
}
