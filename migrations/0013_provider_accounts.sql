CREATE TABLE IF NOT EXISTS provider_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  address TEXT NOT NULL,
  remote_id TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL DEFAULT '',
  token_expires_at TEXT NOT NULL DEFAULT '',
  credential_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  auth_status TEXT NOT NULL DEFAULT 'unchecked',
  remark TEXT NOT NULL DEFAULT '',
  last_checked_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  last_error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, address)
);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_address ON provider_accounts(address);
