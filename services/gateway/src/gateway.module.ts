import { Module, type DynamicModule } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, JWT_SECRET } from './auth/auth.guard';
import type {
  BookingClient,
  CatalogClient,
  InventoryClient,
  PaymentClient,
} from './clients/clients';
import { BOOKINGS, BookingsController, PAYMENTS } from './http/bookings.controller';
import { CATALOG, EventsController, HEARTBEAT_MS, INVENTORY } from './http/events.controller';
import { BookingStreamHub, SeatStreamHub } from './seat-stream/seat-stream';

export interface GatewayOptions {
  catalog: CatalogClient;
  inventory: InventoryClient;
  bookings: BookingClient;
  payments: PaymentClient;
  hub: SeatStreamHub;
  bookingHub: BookingStreamHub;
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
        { provide: PAYMENTS, useValue: o.payments },
        { provide: SeatStreamHub, useValue: o.hub },
        { provide: BookingStreamHub, useValue: o.bookingHub },
        { provide: HEARTBEAT_MS, useValue: o.heartbeatMs ?? 25_000 },
      ],
    };
  }
}
