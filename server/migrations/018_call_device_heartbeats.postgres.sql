-- Device health is separate from the time of its latest real call. Older APKs
-- retain their pairing and call history, with no inferred online/offline status.
CREATE TABLE call_device_heartbeats (
  device_id INTEGER PRIMARY KEY REFERENCES call_devices(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL,
  app_version TEXT NOT NULL CHECK(length(app_version) BETWEEN 1 AND 32),
  android_version TEXT NOT NULL CHECK(length(android_version) BETWEEN 1 AND 32),
  monitoring INTEGER NOT NULL CHECK(monitoring IN (0,1)),
  pending_count INTEGER NOT NULL CHECK(pending_count BETWEEN 0 AND 100000),
  oldest_pending_at TEXT,
  last_error TEXT CHECK(last_error IS NULL OR length(last_error) BETWEEN 1 AND 32)
);
