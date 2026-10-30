-- Keep driver identities and all referenced history; removal only retires a row.
ALTER TABLE drivers ADD COLUMN deleted_at TEXT;
ALTER TABLE drivers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0);
