ALTER TABLE events ADD COLUMN organizer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE event_seats ADD COLUMN price_minor BIGINT NOT NULL DEFAULT 0;

ALTER TABLE tickets DROP CONSTRAINT tickets_status_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
  CHECK (status IN ('valid', 'used', 'refund_requested', 'void'));
ALTER TABLE tickets ADD COLUMN refund_id TEXT;
