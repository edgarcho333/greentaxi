-- Keep every existing inquiry, stage hash, booking link and legacy phase intact.
-- NULL means a pre-upgrade inquiry whose status is its existing phase.
ALTER TABLE call_inquiries ADD COLUMN call_status TEXT
  CHECK(call_status IS NULL OR call_status IN ('ringing','answered','completed','missed','rejected'));
ALTER TABLE call_inquiries ADD COLUMN ringing_hash TEXT;
