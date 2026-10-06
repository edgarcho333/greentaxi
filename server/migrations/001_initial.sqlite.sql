CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stops (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS base_schedule (direction TEXT PRIMARY KEY, times TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS date_schedule (
  direction TEXT NOT NULL, date TEXT NOT NULL, times TEXT NOT NULL, PRIMARY KEY(direction,date)
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL,
  seats INTEGER NOT NULL CHECK(seats BETWEEN 1 AND 4),
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
CREATE INDEX IF NOT EXISTS bookings_slot ON bookings(direction,assigned_date,assigned_time);
CREATE INDEX IF NOT EXISTS bookings_phone ON bookings(phone);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), booking_id INTEGER REFERENCES bookings(id),
  action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
  status INTEGER NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(scope,key)
);
CREATE TABLE IF NOT EXISTS call_devices (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL, last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS call_inquiries (
  id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES call_devices(id),
  event_id TEXT NOT NULL, request_hash TEXT NOT NULL, phone TEXT, occurred_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds>=0), created_at TEXT NOT NULL,
  deleted_at TEXT, booking_id INTEGER REFERENCES bookings(id), UNIQUE(device_id,event_id)
);
CREATE INDEX IF NOT EXISTS call_inquiries_queue ON call_inquiries(deleted_at,booking_id);
CREATE TABLE IF NOT EXISTS passenger_profiles (
  phone TEXT PRIMARY KEY, name TEXT NOT NULL, gori_address TEXT NOT NULL,
  pickup_stop_id INTEGER REFERENCES stops(id), pickup_stop_name TEXT, updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO base_schedule(direction,times) VALUES
  ('gori-tbilisi','["06:00","07:00","08:00","08:30","09:00","09:30","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00"]'),
  ('tbilisi-gori','["06:00","07:00","08:00","08:30","09:00","09:30","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00"]');
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('didubeName','დიდუბე — სატესტო ჩამოსვლის ადგილი'),
  ('didubeAddress','სატესტო მისამართი — ადმინისტრატორმა უნდა დააზუსტოს');
INSERT INTO stops(name,address)
SELECT defaults.name, 'სატესტო მისამართი — ადმინისტრატორმა უნდა დააზუსტოს'
FROM (
  SELECT 'თბილისი — სატესტო გაჩერება 1' AS name
  UNION ALL SELECT 'თბილისი — სატესტო გაჩერება 2'
  UNION ALL SELECT 'თბილისი — სატესტო გაჩერება 3'
) defaults
WHERE NOT EXISTS (SELECT 1 FROM stops);
