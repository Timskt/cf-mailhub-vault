ALTER TABLE accounts ADD COLUMN last_token_refresh_at TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN last_token_attempt_at TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN next_token_refresh_at TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN token_refresh_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN token_refresh_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE accounts ADD COLUMN token_refresh_error TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_accounts_token_renewal ON accounts(status, token_refresh_status, next_token_refresh_at);
