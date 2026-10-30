-- One driver can serve several departures on the same day. Preserve every
-- existing explicit assignment, including the remembered slots of a declined day.
CREATE TABLE driver_trip_assignments (
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  time TEXT NOT NULL CHECK(time GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(time,1,2)<='23'),
  created_at TEXT NOT NULL,
  PRIMARY KEY(driver_id,date,time)
);
CREATE INDEX driver_trip_assignments_date ON driver_trip_assignments(date,time,driver_id);
INSERT INTO driver_trip_assignments(driver_id,date,time,created_at)
SELECT driver_id,date,manual_time,updated_at FROM driver_day_overrides
WHERE assignment_mode='manual' AND manual_time IS NOT NULL;
