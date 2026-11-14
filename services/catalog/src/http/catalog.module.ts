import { Module, type DynamicModule } from '@nestjs/common';
import type { Pool } from 'pg';
import { CatalogController, POOL } from './catalog.controller';

@Module({})
export class CatalogModule {
  static forPool(pool: Pool): DynamicModule {
    return {
      module: CatalogModule,
      controllers: [CatalogController],
      providers: [{ provide: POOL, useValue: pool }],
    };
  }
}
