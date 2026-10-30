-- One driver can serve several departures on the same day. Preserve every
-- existing explicit assignment, including the remembered slots of a declined day.
SELECT pg_advisory_xact_lock(817305621,2);
CREATE TABLE driver_trip_assignments (
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  date TEXT NOT NULL CHECK(date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  time TEXT NOT NULL CHECK(time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  created_at TEXT NOT NULL,
  PRIMARY KEY(driver_id,date,time)
);
CREATE INDEX driver_trip_assignments_date ON driver_trip_assignments(date,time,driver_id);
INSERT INTO driver_trip_assignments(driver_id,date,time,created_at)
SELECT driver_id,date,manual_time,updated_at FROM driver_day_overrides
WHERE assignment_mode='manual' AND manual_time IS NOT NULL;
