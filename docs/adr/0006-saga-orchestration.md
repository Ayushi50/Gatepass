# ADR 0006: Booking saga is orchestrated by the booking service

## Context

Rule 12: the saga must be an explicit, persisted, resumable state machine in the booking service. A booking spans seat-inventory, payment, ticket and refunds, with timeouts and compensation.

## Decision

The booking service owns the saga as an orchestrator. It persists the booking state and the current step, reacts to events (`seats.held`, `payment.succeeded`, `hold.expired`, ...) by transitioning state and emitting the next command-like event through its outbox, and can resume from its table after a crash.

## Trade-offs

- Orchestration gives one place to read the flow, one place to add compensation and timeouts, and an easy "where is this booking stuck" query. Choreography spreads that logic over every service and makes the failure and refund paths hard to follow.
- The booking service becomes a coordination hub and must stay free of other services' business rules. It only decides what happens next.
- Implemented in Phase 1; this ADR fixes the direction now.
