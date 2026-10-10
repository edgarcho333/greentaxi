ALTER TABLE bookings ADD COLUMN caller_phone TEXT;
ALTER TABLE bookings ADD COLUMN luggage INTEGER NOT NULL DEFAULT 0 CHECK(luggage IN (0,1));
ALTER TABLE bookings ADD COLUMN dog INTEGER NOT NULL DEFAULT 0 CHECK(dog IN (0,1));
ALTER TABLE bookings ADD COLUMN seat_preference TEXT CHECK(seat_preference IN ('front','back','middle'));

-- A converted call is an explicit, trusted association. Keep its original caller
-- separately without rewriting the booking contact or any passenger identity.
UPDATE bookings SET caller_phone=(
  SELECT call_inquiries.phone FROM call_inquiries
  WHERE call_inquiries.booking_id=bookings.id AND call_inquiries.phone IS NOT NULL
  ORDER BY call_inquiries.occurred_at,call_inquiries.id LIMIT 1
)
WHERE EXISTS (SELECT 1 FROM call_inquiries WHERE call_inquiries.booking_id=bookings.id AND call_inquiries.phone IS NOT NULL);

CREATE INDEX bookings_caller_phone ON bookings(caller_phone);
