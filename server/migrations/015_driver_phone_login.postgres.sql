-- Phone-only driver login is explicitly configured by staff. Existing accounts,
-- legacy credential hashes, session records and all operational data stay intact.
ALTER TABLE driver_accounts ADD COLUMN phone TEXT
  CHECK(phone IS NULL OR phone ~ '^5[0-9]{8}$');
CREATE UNIQUE INDEX driver_accounts_phone_unique ON driver_accounts(phone);
