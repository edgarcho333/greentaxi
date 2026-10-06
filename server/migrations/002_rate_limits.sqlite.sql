CREATE TABLE IF NOT EXISTS rate_limits (
  scope_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK(count >= 1),
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(reset_at);
