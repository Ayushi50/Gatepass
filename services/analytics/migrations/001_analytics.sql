-- A read model: built only from events, never written by a request.
CREATE TABLE events (
  event_id     TEXT        PRIMARY KEY,
  organizer_id TEXT        NOT NULL,
  title        TEXT        NOT NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  total_seats  INT         NOT NULL
);

-- One row per seat. A seat event can arrive before event.published (topics are consumed in
-- parallel), so rows are upserted from either side: tier is filled by event.published, state by
-- the seat events. `last_event_ms` makes an older event unable to overwrite a newer one.
CREATE TABLE seat_status (
  event_id      TEXT   NOT NULL,
  seat_id       TEXT   NOT NULL,
  tier          TEXT,
  state         TEXT   NOT NULL DEFAULT 'available' CHECK (state IN ('available', 'held', 'sold')),
  last_event_ms BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, seat_id)
);

CREATE TABLE activity (
  id              BIGSERIAL   PRIMARY KEY,
  source_event_id TEXT        NOT NULL UNIQUE,
  event_id        TEXT        NOT NULL,
  booking_id      TEXT        NOT NULL,
  type            TEXT        NOT NULL,
  text            TEXT        NOT NULL,
  failed          BOOLEAN     NOT NULL DEFAULT false,
  occurred_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX activity_by_event ON activity (event_id, occurred_at DESC, id DESC);
