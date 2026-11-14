-- The reverse saga: a refund is requested, approved by the organizer, then completed.
CREATE TABLE refunds (
  id           TEXT        PRIMARY KEY,
  booking_id   TEXT        NOT NULL,
  ticket_id    TEXT        NOT NULL UNIQUE,   -- a ticket is refunded at most once
  event_id     TEXT        NOT NULL,
  seat_id      TEXT        NOT NULL,
  user_id      TEXT        NOT NULL,
  organizer_id TEXT        NOT NULL,          -- the only person who may approve it
  amount_minor BIGINT      NOT NULL,
  currency     TEXT        NOT NULL,
  state        TEXT        NOT NULL CHECK (state IN ('REQUESTED', 'APPROVED', 'COMPLETED')),
  approved_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refunds_by_booking ON refunds (booking_id);
