-- Child booking references are nullable. Park and restore them within the migration
-- transaction so foreign_keys stays ON and no parent rename retargets their schema.
CREATE TEMP TABLE _staff_seats_audit_refs (id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL);
INSERT INTO _staff_seats_audit_refs SELECT id,booking_id FROM audit_log WHERE booking_id IS NOT NULL;
CREATE TEMP TABLE _staff_seats_call_refs (id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL);
INSERT INTO _staff_seats_call_refs SELECT id,booking_id FROM call_inquiries WHERE booking_id IS NOT NULL;
UPDATE audit_log SET booking_id=NULL WHERE booking_id IS NOT NULL;
UPDATE call_inquiries SET booking_id=NULL WHERE booking_id IS NOT NULL;

CREATE TABLE bookings_staff_seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL,
  seats INTEGER NOT NULL CHECK(seats BETWEEN 1 AND 8),
  direction TEXT NOT NULL CHECK(direction IN ('gori-tbilisi','tbilisi-gori')),
  gori_address TEXT NOT NULL, pickup_stop_id INTEGER REFERENCES stops(id), pickup_stop_name TEXT,
  didube_name TEXT NOT NULL, didube_address TEXT NOT NULL,
  requested_date TEXT NOT NULL, requested_time TEXT NOT NULL,
  assigned_date TEXT, assigned_time TEXT,
  status TEXT NOT NULL CHECK(status IN ('waiting','confirmed')),
  deleted_at TEXT, source TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK((status='waiting' AND assigned_date IS NULL AND assigned_time IS NULL) OR
        (status='confirmed' AND assigned_date IS NOT NULL AND assigned_time IS NOT NULL))
);
-- Creating the AUTOINCREMENT table also makes sqlite_sequence available for
-- ordinary installations. Preserve any larger sequence from a legacy booking table.
CREATE TEMP TABLE _staff_seats_sequence (seq INTEGER);
INSERT INTO _staff_seats_sequence SELECT MAX(seq) FROM sqlite_sequence WHERE name='bookings';
INSERT INTO bookings_staff_seats (
  id,name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,
  didube_name,didube_address,requested_date,requested_time,assigned_date,assigned_time,
  status,deleted_at,source,created_at,updated_at
)
SELECT
  id,name,phone,seats,direction,gori_address,pickup_stop_id,pickup_stop_name,
  didube_name,didube_address,requested_date,requested_time,assigned_date,assigned_time,
  status,deleted_at,source,created_at,updated_at
FROM bookings;
DROP TABLE bookings;
ALTER TABLE bookings_staff_seats RENAME TO bookings;
CREATE INDEX bookings_slot ON bookings(direction,assigned_date,assigned_time);
CREATE INDEX bookings_phone ON bookings(phone);

UPDATE sqlite_sequence
SET seq=MAX(COALESCE(seq,0),COALESCE((SELECT MAX(seq) FROM _staff_seats_sequence),0))
WHERE name='bookings';
INSERT INTO sqlite_sequence(name,seq)
SELECT 'bookings',seq FROM _staff_seats_sequence
WHERE seq IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='bookings');

UPDATE audit_log
SET booking_id=(SELECT booking_id FROM _staff_seats_audit_refs WHERE id=audit_log.id)
WHERE id IN (SELECT id FROM _staff_seats_audit_refs);
UPDATE call_inquiries
SET booking_id=(SELECT booking_id FROM _staff_seats_call_refs WHERE id=call_inquiries.id)
WHERE id IN (SELECT id FROM _staff_seats_call_refs);

-- Abort the transaction if any restored reference fails validation.
CREATE TEMP TABLE _staff_seats_fk_guard (violations INTEGER NOT NULL CHECK(violations=0));
INSERT INTO _staff_seats_fk_guard SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE _staff_seats_fk_guard;
DROP TABLE _staff_seats_sequence;
DROP TABLE _staff_seats_audit_refs;
DROP TABLE _staff_seats_call_refs;
