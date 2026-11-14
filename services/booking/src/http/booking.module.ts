import { Module, type DynamicModule } from '@nestjs/common';
import type { Pool } from 'pg';
import { BookingController, POOL } from './booking.controller';

@Module({})
export class BookingModule {
  static forPool(pool: Pool): DynamicModule {
    return {
      module: BookingModule,
      controllers: [BookingController],
      providers: [{ provide: POOL, useValue: pool }],
    };
  }
}
