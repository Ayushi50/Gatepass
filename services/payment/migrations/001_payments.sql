-- What a booking can be charged: filled from seats.held, closed by seats.released / payment outcome.
CREATE TABLE payables (
  booking_id      TEXT        PRIMARY KEY,
  event_id        TEXT        NOT NULL,
  amount_minor    BIGINT      NOT NULL,
  currency        TEXT        NOT NULL,
  hold_expires_at TIMESTAMPTZ NOT NULL,
  state           TEXT        NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'paid', 'closed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id                  TEXT        PRIMARY KEY,
  booking_id          TEXT        NOT NULL REFERENCES payables (booking_id),
  idempotency_key     TEXT        NOT NULL,
  request_fingerprint TEXT        NOT NULL,
  user_id             TEXT        NOT NULL,
  method              TEXT        NOT NULL,
  amount_minor        BIGINT      NOT NULL,
  currency            TEXT        NOT NULL,
  state               TEXT        NOT NULL
                      CHECK (state IN ('CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
  provider            TEXT        NOT NULL,
  provider_ref        TEXT,
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- the same client request (same key) can only ever create one payment
  CONSTRAINT payments_idempotency UNIQUE (booking_id, idempotency_key)
);

-- Double-charge guard: a booking can have at most one payment that is not FAILED.
CREATE UNIQUE INDEX one_live_payment_per_booking ON payments (booking_id) WHERE state <> 'FAILED';

-- Every provider webhook we accept, for dedupe and audit.
CREATE TABLE webhook_events (
  provider          TEXT        NOT NULL,
  provider_event_id TEXT        NOT NULL,
  payment_id        TEXT,
  outcome           TEXT        NOT NULL,
  result            TEXT,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_event_id)
);
