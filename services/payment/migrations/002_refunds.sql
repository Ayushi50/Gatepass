-- The provider's own id for the payment (needed to refund it). Learned from the provider webhook.
ALTER TABLE payments ADD COLUMN provider_payment_id TEXT;

CREATE TABLE refunds (
  id                  TEXT        PRIMARY KEY,   -- the saga's refund id, or "auto-<paymentId>"
  payment_id          TEXT        NOT NULL REFERENCES payments (id),
  booking_id          TEXT        NOT NULL,
  event_id            TEXT        NOT NULL DEFAULT '',
  ticket_id           TEXT        NOT NULL DEFAULT '',
  seat_id             TEXT        NOT NULL DEFAULT '',
  user_id             TEXT        NOT NULL DEFAULT '',
  amount_minor        BIGINT      NOT NULL CHECK (amount_minor > 0),
  currency            TEXT        NOT NULL,
  automatic           BOOLEAN     NOT NULL DEFAULT false,
  state               TEXT        NOT NULL CHECK (state IN ('PENDING', 'COMPLETED')),
  provider_refund_ref TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refunds_by_payment ON refunds (payment_id);
