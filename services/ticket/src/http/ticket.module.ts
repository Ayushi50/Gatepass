import { Module, type DynamicModule } from '@nestjs/common';
import type { Pool } from 'pg';
import type { QrKeyRing } from '../qr-token';
import { KEYS, POOL, TicketController } from './ticket.controller';

@Module({})
export class TicketModule {
  static forDeps(pool: Pool, keys: QrKeyRing): DynamicModule {
    return {
      module: TicketModule,
      controllers: [TicketController],
      providers: [
        { provide: POOL, useValue: pool },
        { provide: KEYS, useValue: keys },
      ],
    };
  }
}
