-- Child booking references are nullable. Park and restore them within the migration
-- transaction so foreign_keys stays ON and no parent rename retargets their schema.
CREATE TEMP TABLE _booking_kinds_audit_refs (id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL);
INSERT INTO _booking_kinds_audit_refs SELECT id,booking_id FROM audit_log WHERE booking_id IS NOT NULL;
CREATE TEMP TABLE _booking_kinds_call_refs (id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL);
INSERT INTO _booking_kinds_call_refs SELECT id,booking_id FROM call_inquiries WHERE booking_id IS NOT NULL;
UPDATE audit_log SET booking_id=NULL WHERE booking_id IS NOT NULL;
UPDATE call_inquiries SET booking_id=NULL WHERE booking_id IS NOT NULL;

CREATE TEMP TABLE _booking_kinds_links AS SELECT * FROM call_booking_links;
DELETE FROM call_booking_links;
CREATE TABLE bookings_booking_kinds (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL,
  seats INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('gori-tbilisi','tbilisi-gori')),
  gori_address TEXT NOT NULL, pickup_stop_id INTEGER REFERENCES stops(id), pickup_stop_name TEXT,
  didube_name TEXT NOT NULL, didube_address TEXT NOT NULL,
  requested_date TEXT NOT NULL, requested_time TEXT NOT NULL,
  assigned_date TEXT, assigned_time TEXT,
  status TEXT NOT NULL CHECK(status IN ('waiting','confirmed')),
  deleted_at TEXT, source TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  booking_type TEXT NOT NULL DEFAULT 'passenger' CHECK(booking_type IN ('passenger','parcel','whole_car')),
  assigned_vehicle_key TEXT, assigned_vehicle_name TEXT,
  caller_phone TEXT, luggage INTEGER NOT NULL DEFAULT 0 CHECK(luggage IN (0,1)),
  dog INTEGER NOT NULL DEFAULT 0 CHECK(dog IN (0,1)),
  seat_preference TEXT CHECK(seat_preference IN ('front','back','middle')),
  CHECK((booking_type='parcel' AND seats=0 AND assigned_vehicle_key IS NULL) OR
        (booking_type='passenger' AND seats BETWEEN 1 AND 8 AND assigned_vehicle_key IS NULL) OR
        (booking_type='whole_car' AND seats BETWEEN 1 AND 8 AND assigned_vehicle_key IS NOT NULL AND assigned_vehicle_name IS NOT NULL)),
  CHECK((status='waiting' AND assigned_date IS NULL AND assigned_time IS NULL) OR
        (status='confirmed' AND assigned_date IS NOT NULL AND assigned_time IS NOT NULL))
);
-- Creating the AUTOINCREMENT table also makes sqlite_sequence available for
-- ordinary installations. Preserve any larger sequence from a legacy booking table.
CREATE TEMP TABLE _booking_kinds_sequence (seq INTEGER);
INSERT INTO _booking_kinds_sequence SELECT MAX(seq) FROM sqlite_sequence WHERE name='bookings';
INSERT INTO bookings_booking_kinds (
  id,name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,
  didube_name,didube_address,requested_date,requested_time,assigned_date,assigned_time,
  status,deleted_at,source,created_at,updated_at,caller_phone,luggage,dog,seat_preference
)
SELECT
  id,name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,
  didube_name,didube_address,requested_date,requested_time,assigned_date,assigned_time,
  status,deleted_at,source,created_at,updated_at,caller_phone,luggage,dog,seat_preference
FROM bookings;
DROP TABLE bookings;
ALTER TABLE bookings_booking_kinds RENAME TO bookings;
CREATE INDEX bookings_slot ON bookings(direction,assigned_date,assigned_time);
CREATE INDEX bookings_phone ON bookings(phone);
CREATE INDEX bookings_caller_phone ON bookings(caller_phone);
INSERT INTO call_booking_links SELECT * FROM _booking_kinds_links;
DROP TABLE _booking_kinds_links;

UPDATE sqlite_sequence
SET seq=MAX(COALESCE(seq,0),COALESCE((SELECT MAX(seq) FROM _booking_kinds_sequence),0))
WHERE name='bookings';
INSERT INTO sqlite_sequence(name,seq)
SELECT 'bookings',seq FROM _booking_kinds_sequence
WHERE seq IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='bookings');

UPDATE audit_log
SET booking_id=(SELECT booking_id FROM _booking_kinds_audit_refs WHERE id=audit_log.id)
WHERE id IN (SELECT id FROM _booking_kinds_audit_refs);
UPDATE call_inquiries
SET booking_id=(SELECT booking_id FROM _booking_kinds_call_refs WHERE id=call_inquiries.id)
WHERE id IN (SELECT id FROM _booking_kinds_call_refs);

-- Abort the transaction if any restored reference fails validation.
CREATE TEMP TABLE _booking_kinds_fk_guard (violations INTEGER NOT NULL CHECK(violations=0));
INSERT INTO _booking_kinds_fk_guard SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE _booking_kinds_fk_guard;
DROP TABLE _booking_kinds_sequence;
DROP TABLE _booking_kinds_audit_refs;
DROP TABLE _booking_kinds_call_refs;
