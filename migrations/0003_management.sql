-- Existing accounts start unchecked. Importing credentials does not prove they work.
ALTER TABLE accounts ADD COLUMN auth_status TEXT NOT NULL DEFAULT 'unchecked';
ALTER TABLE accounts ADD COLUMN last_checked_at TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN last_error_code TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_accounts_group_status ON accounts(group_id, status, auth_status, id);
CREATE INDEX idx_vault_source_email ON platform_vault(email_source, account_email);
CREATE INDEX idx_cf_recipient_created ON cf_inbox_mails(recipient, created_at DESC, id DESC);
CREATE INDEX idx_cf_message_recipient ON cf_inbox_mails(message_id, recipient);
CREATE INDEX idx_mailboxes_domain_id ON temp_mailboxes(domain, id DESC);

CREATE TABLE domains (
  domain TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  remark TEXT NOT NULL DEFAULT '',
  dns_status TEXT NOT NULL DEFAULT 'unchecked',
  last_checked_at TEXT NOT NULL DEFAULT '',
  last_received_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE oauth_sessions (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  group_id INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL
);

CREATE TABLE auth_attempts (
  identity TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- Bring existing platform-linked mailboxes under the same lifecycle rules as new ones.
INSERT INTO temp_mailboxes (address, prefix, domain, is_permanent, associated_vault_id, associated_platform)
SELECT account_email, substr(account_email, 1, instr(account_email, '@') - 1), substr(account_email, instr(account_email, '@') + 1),
  1, min(id), platform_name FROM platform_vault WHERE email_source = 'cf_domain' GROUP BY account_email
ON CONFLICT(address) DO UPDATE SET is_permanent = 1, expires_at = '', associated_vault_id = excluded.associated_vault_id,
  associated_platform = excluded.associated_platform;
UPDATE cf_inbox_mails SET is_protected = 1 WHERE recipient IN
  (SELECT account_email FROM platform_vault WHERE email_source = 'cf_domain') OR recipient IN
  (SELECT address FROM temp_mailboxes WHERE is_permanent = 1);
