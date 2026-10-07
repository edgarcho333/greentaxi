ALTER TABLE call_inquiries ADD COLUMN legacy_hash INTEGER NOT NULL DEFAULT 1
  CHECK(legacy_hash IN (0,1));
