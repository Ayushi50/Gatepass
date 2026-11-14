import { Module, type DynamicModule } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, JWT_SECRET } from './auth/auth.guard';
import type { BookingClient, CatalogClient, InventoryClient } from './clients/clients';
import { BOOKINGS, BookingsController } from './http/bookings.controller';
import { CATALOG, EventsController, HEARTBEAT_MS, INVENTORY } from './http/events.controller';
import { SeatStreamHub } from './seat-stream/seat-stream';

export interface GatewayOptions {
  catalog: CatalogClient;
  inventory: InventoryClient;
  bookings: BookingClient;
  hub: SeatStreamHub;
  jwtSecret: string;
  heartbeatMs?: number;
}

@Module({})
export class GatewayModule {
  static forRoot(o: GatewayOptions): DynamicModule {
    return {
      module: GatewayModule,
      controllers: [EventsController, BookingsController],
      providers: [
        Reflector,
        AuthGuard,
        { provide: JWT_SECRET, useValue: o.jwtSecret },
        { provide: CATALOG, useValue: o.catalog },
        { provide: INVENTORY, useValue: o.inventory },
        { provide: BOOKINGS, useValue: o.bookings },
        { provide: SeatStreamHub, useValue: o.hub },
        { provide: HEARTBEAT_MS, useValue: o.heartbeatMs ?? 25_000 },
      ],
    };
  }
}
