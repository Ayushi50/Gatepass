import { Module, type DynamicModule } from '@nestjs/common';
import type { Pool } from 'pg';
import { InventoryController, POOL } from './inventory.controller';

@Module({})
export class InventoryModule {
  static forPool(pool: Pool): DynamicModule {
    return {
      module: InventoryModule,
      controllers: [InventoryController],
      providers: [{ provide: POOL, useValue: pool }],
    };
  }
}
