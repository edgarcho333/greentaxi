ALTER TABLE bookings DROP CONSTRAINT bookings_seats_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_seats_check CHECK(seats BETWEEN 1 AND 8);
