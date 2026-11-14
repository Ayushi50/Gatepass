import {
  BookingCancelledSchema,
  BookingConfirmedSchema,
  BookingRequestedSchema,
  EventPublishedSchema,
  HoldExpiredSchema,
  PaymentFailedSchema,
  PaymentSucceededSchema,
  RefundApprovedSchema,
  RefundCompletedSchema,
  RefundRequestedSchema,
  SeatsHeldSchema,
  SeatsHoldFailedSchema,
  SeatsReleasedSchema,
  SeatsSaleFailedSchema,
  SeatsSoldSchema,
  TicketIssuedSchema,
  TicketVoidedSchema,
} from './gen/gatepass/events/v1/events_pb';

/**
 * The single source of truth mapping an eventType string to its oneof case and schema.
 * Topic name == eventType. Adding an event = add a oneof member in the .proto + one line here.
 */
export const EVENT_CATALOG = {
  'event.published': { case: 'eventPublished', schema: EventPublishedSchema },
  'booking.requested': { case: 'bookingRequested', schema: BookingRequestedSchema },
  'booking.confirmed': { case: 'bookingConfirmed', schema: BookingConfirmedSchema },
  'booking.cancelled': { case: 'bookingCancelled', schema: BookingCancelledSchema },
  'seats.held': { case: 'seatsHeld', schema: SeatsHeldSchema },
  'seats.hold_failed': { case: 'seatsHoldFailed', schema: SeatsHoldFailedSchema },
  'seats.released': { case: 'seatsReleased', schema: SeatsReleasedSchema },
  'seats.sold': { case: 'seatsSold', schema: SeatsSoldSchema },
  'hold.expired': { case: 'holdExpired', schema: HoldExpiredSchema },
  'payment.succeeded': { case: 'paymentSucceeded', schema: PaymentSucceededSchema },
  'payment.failed': { case: 'paymentFailed', schema: PaymentFailedSchema },
  'refund.requested': { case: 'refundRequested', schema: RefundRequestedSchema },
  'refund.completed': { case: 'refundCompleted', schema: RefundCompletedSchema },
  'ticket.issued': { case: 'ticketIssued', schema: TicketIssuedSchema },
  'ticket.voided': { case: 'ticketVoided', schema: TicketVoidedSchema },
  'refund.approved': { case: 'refundApproved', schema: RefundApprovedSchema },
  'seats.sale_failed': { case: 'seatsSaleFailed', schema: SeatsSaleFailedSchema },
} as const;

export type EventType = keyof typeof EVENT_CATALOG;

export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as EventType[];

/** Topic for an event type (1:1 with the event type). */
export const topicFor = (eventType: EventType): string => eventType;

export const isEventType = (value: string): value is EventType =>
  Object.prototype.hasOwnProperty.call(EVENT_CATALOG, value);
