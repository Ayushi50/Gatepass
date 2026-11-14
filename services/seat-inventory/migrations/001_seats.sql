CREATE TABLE seats (
  event_id        TEXT        NOT NULL,
  seat_id         TEXT        NOT NULL,
  row_label       TEXT        NOT NULL,
  number          INT         NOT NULL,
  tier            TEXT        NOT NULL,
  price_minor     BIGINT      NOT NULL,
  state           TEXT        NOT NULL DEFAULT 'available'
                  CHECK (state IN ('available', 'held', 'sold')),
  booking_id      TEXT,
  hold_expires_at TIMESTAMPTZ,
  version         INT         NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, seat_id),
  -- Last line of defence: a seat has an owner if and only if it is not available.
  CONSTRAINT seat_owner_matches_state CHECK ((state = 'available') = (booking_id IS NULL))
);

CREATE INDEX seats_by_booking ON seats (booking_id) WHERE booking_id IS NOT NULL;
