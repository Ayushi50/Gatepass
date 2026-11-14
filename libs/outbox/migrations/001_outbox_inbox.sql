-- Applied to EVERY service database. Idempotent.

CREATE TABLE IF NOT EXISTS outbox (
  id             BIGSERIAL   PRIMARY KEY,          -- the relay publishes strictly in id order
  event_id       UUID        NOT NULL UNIQUE,
  event_type     TEXT        NOT NULL,
  aggregate_id   TEXT        NOT NULL,             -- Kafka message key
  correlation_id TEXT        NOT NULL,
  causation_id   TEXT,
  version        INT         NOT NULL DEFAULT 1,
  payload        BYTEA       NOT NULL,             -- serialized EventEnvelope
  headers        JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ,                      -- NULL = still pending
  attempts       INT         NOT NULL DEFAULT 0,
  last_error     TEXT
);

CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (id) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS inbox (
  consumer     TEXT        NOT NULL,               -- consumer group / handler name
  event_id     UUID        NOT NULL,
  event_type   TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
