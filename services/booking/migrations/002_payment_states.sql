ALTER TABLE bookings DROP CONSTRAINT bookings_state_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_state_check
  CHECK (state IN ('REQUESTED', 'HELD', 'PAID', 'CONFIRMED', 'CANCELLED'));
ALTER TABLE bookings ADD COLUMN amount_minor BIGINT;
ALTER TABLE bookings ADD COLUMN currency TEXT;
