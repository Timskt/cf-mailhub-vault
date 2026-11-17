-- Expand only. Existing IDs, credentials, platform records and manual states remain intact.
ALTER TABLE platform_vault ADD COLUMN workspace TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_vault ADD COLUMN account_identifier TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_vault ADD COLUMN login_methods TEXT NOT NULL DEFAULT '["unknown"]';
ALTER TABLE platform_vault ADD COLUMN mailbox_address TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_vault ADD COLUMN mailbox_link_state TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE platform_vault ADD COLUMN verification_sender TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_vault ADD COLUMN verification_keyword TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_vault ADD COLUMN registered_at TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_vault ADD COLUMN last_verified_at TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_vault ADD COLUMN expires_at TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_vault_delivery ON platform_vault(email_source, mailbox_address);
