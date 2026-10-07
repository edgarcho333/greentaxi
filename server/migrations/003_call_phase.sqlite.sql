ALTER TABLE call_inquiries ADD COLUMN phase TEXT NOT NULL DEFAULT 'completed'
  CHECK(phase IN ('answered','completed'));
ALTER TABLE call_inquiries ADD COLUMN answered_hash TEXT;
