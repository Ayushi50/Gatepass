-- The email / SMS log. Nothing is actually sent: a row IS the notification.
CREATE TABLE notifications (
  id              BIGSERIAL   PRIMARY KEY,
  source_event_id TEXT        NOT NULL,   -- the event that caused it
  user_id         TEXT        NOT NULL,
  booking_id      TEXT        NOT NULL,
  channel         TEXT        NOT NULL CHECK (channel IN ('email', 'sms')),
  template        TEXT        NOT NULL,
  subject         TEXT,
  body            TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'logged',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- one email and one SMS per triggering event, however often it is delivered
  CONSTRAINT one_per_event_and_channel UNIQUE (source_event_id, channel)
);

CREATE INDEX notifications_by_user ON notifications (user_id, created_at DESC);
