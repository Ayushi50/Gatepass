import { Module, type DynamicModule } from '@nestjs/common';
import type { Pool } from 'pg';
import { AnalyticsController, POOL } from './analytics.controller';

@Module({})
export class AnalyticsModule {
  static forPool(pool: Pool): DynamicModule {
    return {
      module: AnalyticsModule,
      controllers: [AnalyticsController],
      providers: [{ provide: POOL, useValue: pool }],
    };
  }
}
