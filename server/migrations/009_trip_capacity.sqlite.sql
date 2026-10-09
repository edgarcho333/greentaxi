-- One-off cars belong to this trip, never to the permanent rotating queue.
CREATE TABLE temporary_trip_drivers (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK(direction='gori-tbilisi'),
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  time TEXT NOT NULL CHECK(time GLOB '[0-2][0-9]:[0-5][0-9]' AND time<='23:59'),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 8),
  sort_order INTEGER NOT NULL CHECK(sort_order>0),
  created_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE INDEX temporary_trip_drivers_slot ON temporary_trip_drivers(direction,date,time,removed_at,sort_order);
