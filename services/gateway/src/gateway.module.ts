import { Module, type DynamicModule } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, JWT_SECRET } from './auth/auth.guard';
import type {
  AnalyticsClient,
  BookingClient,
  CatalogClient,
  InventoryClient,
  PaymentClient,
  TicketClient,
} from './clients/clients';
import { BOOKINGS, BookingsController, PAYMENTS } from './http/bookings.controller';
import { CATALOG, EventsController, HEARTBEAT_MS, INVENTORY } from './http/events.controller';
import { OrganizerController, ANALYTICS } from './http/organizer.controller';
import { DEV_LOGIN, DevLoginController } from './http/dev-login.controller';
import { GOOGLE, GoogleAuth, type GoogleOptions } from './auth/google';
import { GoogleAuthController } from './http/google-auth.controller';
import {
  PAYMENTS_CONFIG,
  PaymentsConfigController,
  type PaymentsConfig,
} from './http/payments-config.controller';
import { WaitingRoomController } from './http/waiting-room.controller';
import { ADMISSION_CATALOG, AdmissionGate } from './waiting-room/admission';
import { WaitingRoom } from './waiting-room/waiting-room';
import { TICKETS, TicketsController } from './http/tickets.controller';
import { ActivityStreamHub, BookingStreamHub, SeatStreamHub } from './seat-stream/seat-stream';

export interface GatewayOptions {
  catalog: CatalogClient;
  inventory: InventoryClient;
  bookings: BookingClient;
  payments: PaymentClient;
  tickets: TicketClient;
  analytics: AnalyticsClient;
  hub: SeatStreamHub;
  bookingHub: BookingStreamHub;
  activityHub: ActivityStreamHub;
  waitingRoom: WaitingRoom;
  jwtSecret: string;
  heartbeatMs?: number;
  /** Demo sign-in. Off unless explicitly enabled (and never in production; see main.ts). */
  devLogin?: boolean;
  /** "Sign in with Google". Absent = the routes answer 404. */
  google?: GoogleOptions;
  /** What the checkout page needs to know about the payment provider. Default: the fake one. */
  paymentsConfig?: PaymentsConfig;
}

@Module({})
export class GatewayModule {
  static forRoot(o: GatewayOptions): DynamicModule {
    return {
      module: GatewayModule,
      controllers: [
        EventsController,
        BookingsController,
        TicketsController,
        OrganizerController,
        WaitingRoomController,
        DevLoginController,
        GoogleAuthController,
        PaymentsConfigController,
      ],
      providers: [
        Reflector,
        AuthGuard,
        { provide: JWT_SECRET, useValue: o.jwtSecret },
        { provide: CATALOG, useValue: o.catalog },
        { provide: INVENTORY, useValue: o.inventory },
        { provide: BOOKINGS, useValue: o.bookings },
        { provide: PAYMENTS, useValue: o.payments },
        { provide: TICKETS, useValue: o.tickets },
        { provide: ANALYTICS, useValue: o.analytics },
        { provide: ActivityStreamHub, useValue: o.activityHub },
        { provide: WaitingRoom, useValue: o.waitingRoom },
        { provide: PAYMENTS_CONFIG, useValue: o.paymentsConfig ?? { provider: 'fake' } },
        { provide: DEV_LOGIN, useValue: o.devLogin ?? false },
        { provide: GOOGLE, useValue: o.google ? new GoogleAuth(o.google, o.jwtSecret) : null },
        { provide: ADMISSION_CATALOG, useValue: o.catalog },
        AdmissionGate,
        { provide: SeatStreamHub, useValue: o.hub },
        { provide: BookingStreamHub, useValue: o.bookingHub },
        { provide: HEARTBEAT_MS, useValue: o.heartbeatMs ?? 25_000 },
      ],
    };
  }
}
