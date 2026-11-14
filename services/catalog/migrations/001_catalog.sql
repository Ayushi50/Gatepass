CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  organizer_id TEXT        NOT NULL,
  title        TEXT        NOT NULL,
  category     TEXT        NOT NULL,
  venue        TEXT        NOT NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  currency     TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE event_tiers (
  event_id    TEXT   NOT NULL REFERENCES events (id),
  name        TEXT   NOT NULL,
  price_minor BIGINT NOT NULL,
  seat_count  INT    NOT NULL,
  position    INT    NOT NULL,
  PRIMARY KEY (event_id, name)
);

CREATE TABLE seat_defs (
  event_id    TEXT   NOT NULL REFERENCES events (id),
  seat_id     TEXT   NOT NULL,
  row_label   TEXT   NOT NULL,
  number      INT    NOT NULL,
  tier        TEXT   NOT NULL,
  price_minor BIGINT NOT NULL,
  PRIMARY KEY (event_id, seat_id)
);
