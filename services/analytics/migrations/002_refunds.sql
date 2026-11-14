-- Refund requests for the organizer's "Needs you" list. `rank` only ever goes up
-- (1 requested, 2 approved, 3 completed), so events arriving out of order cannot move one backwards.
CREATE TABLE refunds (
  refund_id    TEXT        PRIMARY KEY,
  event_id     TEXT        NOT NULL,
  booking_id   TEXT        NOT NULL,
  ticket_id    TEXT        NOT NULL,
  seat_id      TEXT        NOT NULL DEFAULT '',
  user_id      TEXT        NOT NULL DEFAULT '',
  amount_minor BIGINT      NOT NULL DEFAULT 0,
  currency     TEXT        NOT NULL DEFAULT '',
  rank         INT         NOT NULL CHECK (rank BETWEEN 1 AND 3),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refunds_by_event ON refunds (event_id, rank, created_at);
