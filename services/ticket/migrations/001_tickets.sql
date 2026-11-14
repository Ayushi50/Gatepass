-- This service's own copy of what a ticket must show, built from event.published.
CREATE TABLE events (
  event_id  TEXT        PRIMARY KEY,
  title     TEXT        NOT NULL,
  venue     TEXT        NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE event_seats (
  event_id  TEXT NOT NULL REFERENCES events (event_id),
  seat_id   TEXT NOT NULL,
  row_label TEXT NOT NULL,
  number    INT  NOT NULL,
  tier      TEXT NOT NULL,
  PRIMARY KEY (event_id, seat_id)
);

CREATE TABLE tickets (
  id         TEXT        PRIMARY KEY,
  code       TEXT        NOT NULL,   -- printed on the ticket, like GP-7QX2-C6 (display only)
  booking_id TEXT        NOT NULL,
  event_id   TEXT        NOT NULL,
  user_id    TEXT        NOT NULL,
  seat_id    TEXT        NOT NULL,
  row_label  TEXT        NOT NULL,
  number     INT         NOT NULL,
  tier       TEXT        NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'used')),
  used_at    TIMESTAMPTZ,
  used_by    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- issuing is idempotent: one ticket per seat per booking, however often confirmed arrives
  CONSTRAINT one_ticket_per_seat UNIQUE (booking_id, seat_id),
  CONSTRAINT used_has_time CHECK ((status = 'used') = (used_at IS NOT NULL))
);

CREATE INDEX tickets_by_user ON tickets (user_id, created_at DESC);
