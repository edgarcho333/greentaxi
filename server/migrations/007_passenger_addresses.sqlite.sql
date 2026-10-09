-- Keep every trusted saved address independently of the last-address profile defaults.
CREATE TABLE passenger_addresses (
  phone TEXT NOT NULL,
  city TEXT NOT NULL CHECK (city IN ('gori','tbilisi')),
  address_key TEXT NOT NULL,
  address TEXT NOT NULL,
  pickup_stop_id INTEGER REFERENCES stops(id),
  pickup_stop_name TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (phone,city,address_key)
);
