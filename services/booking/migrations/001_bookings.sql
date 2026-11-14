CREATE TABLE bookings (
  id              TEXT        PRIMARY KEY,
  event_id        TEXT        NOT NULL,
  user_id         TEXT        NOT NULL,
  seat_ids        TEXT[]      NOT NULL,
  state           TEXT        NOT NULL CHECK (state IN ('REQUESTED', 'HELD', 'CANCELLED')),
  hold_expires_at TIMESTAMPTZ,
  cancel_reason   TEXT,
  version         INT         NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bookings_by_user ON bookings (user_id, created_at DESC);

-- Append-only history of the saga: every state change and the event that caused it.
CREATE TABLE booking_transitions (
  id             BIGSERIAL   PRIMARY KEY,
  booking_id     TEXT        NOT NULL REFERENCES bookings (id),
  from_state     TEXT,
  to_state       TEXT        NOT NULL,
  cause_event_id TEXT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX booking_transitions_by_booking ON booking_transitions (booking_id, id);
