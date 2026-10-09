-- Keep Gori pickup memory separate from the last Gori destination on reverse trips.
-- Trusted, direction-aware history is backfilled by the application once.
ALTER TABLE passenger_profiles ADD COLUMN gori_pickup_address TEXT NOT NULL DEFAULT '';
ALTER TABLE passenger_profiles ADD COLUMN gori_pickup_updated_at TEXT;
