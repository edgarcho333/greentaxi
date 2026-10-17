ALTER TABLE bookings ADD COLUMN booking_type TEXT NOT NULL DEFAULT 'passenger' CHECK(booking_type IN ('passenger','parcel','whole_car'));
ALTER TABLE bookings ADD COLUMN assigned_vehicle_key TEXT;
ALTER TABLE bookings ADD COLUMN assigned_vehicle_name TEXT;
ALTER TABLE bookings DROP CONSTRAINT bookings_seats_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_type_seats_check CHECK(
  (booking_type='parcel' AND seats=0 AND assigned_vehicle_key IS NULL) OR
  (booking_type='passenger' AND seats BETWEEN 1 AND 8 AND assigned_vehicle_key IS NULL) OR
  (booking_type='whole_car' AND seats BETWEEN 1 AND 8 AND assigned_vehicle_key IS NOT NULL AND assigned_vehicle_name IS NOT NULL)
);
