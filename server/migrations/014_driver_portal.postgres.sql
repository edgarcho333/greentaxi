-- Driver credentials and sessions never grant staff privileges. Accounts are
-- provisioned explicitly; migrations create no default logins or passwords.
CREATE TABLE driver_accounts (
  driver_id INTEGER PRIMARY KEY REFERENCES drivers(id),
  login TEXT NOT NULL UNIQUE CHECK(length(login) BETWEEN 3 AND 64 AND login=lower(login)),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE driver_sessions (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  driver_id INTEGER NOT NULL REFERENCES driver_accounts(driver_id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX driver_sessions_account ON driver_sessions(driver_id,expires_at);
