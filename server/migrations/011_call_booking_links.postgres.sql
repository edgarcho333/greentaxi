CREATE TABLE call_booking_links (
  call_id BIGINT NOT NULL REFERENCES call_inquiries(id),
  booking_id BIGINT NOT NULL REFERENCES bookings(id),
  PRIMARY KEY(call_id,booking_id)
);
CREATE INDEX call_booking_links_booking ON call_booking_links(booking_id);

-- Retain every legacy association, including calls that reference the same
-- historical booking. New conversions create a distinct booking per passenger.
INSERT INTO call_booking_links(call_id,booking_id)
SELECT id,booking_id FROM call_inquiries WHERE booking_id IS NOT NULL;
