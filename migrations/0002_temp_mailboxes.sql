-- 8. 临时邮箱生命周期管理表 (Temp Mailboxes Lifecycle Manager)
CREATE TABLE IF NOT EXISTS temp_mailboxes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  address             TEXT NOT NULL UNIQUE,
  prefix              TEXT DEFAULT '',
  domain              TEXT DEFAULT '',
  expires_at          TEXT DEFAULT '',
  is_permanent        INTEGER DEFAULT 0,
  associated_platform TEXT DEFAULT '',
  associated_vault_id INTEGER DEFAULT NULL,
  remark              TEXT DEFAULT '',
  is_pinned           INTEGER DEFAULT 0,
  created_at          TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_temp_mailboxes_addr ON temp_mailboxes(address);
CREATE INDEX IF NOT EXISTS idx_temp_mailboxes_exp ON temp_mailboxes(expires_at);
CREATE INDEX IF NOT EXISTS idx_temp_mailboxes_perm ON temp_mailboxes(is_permanent);
