-- 1. 系统设置表 (Settings)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 2. 账号分组表 (Groups)
CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  color       TEXT DEFAULT '#2563eb',
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO groups (id, name, description, color)
VALUES (1, '默认分组', '默认分组', '#2563eb');

-- 3. 标签表 (Tags)
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT DEFAULT '#6366f1',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 4. Outlook 账号矩阵表 (Accounts)
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  client_id     TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  password      TEXT DEFAULT '',
  group_id      INTEGER DEFAULT 1,
  remark        TEXT DEFAULT '',
  status        TEXT DEFAULT 'active',
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

CREATE TABLE IF NOT EXISTS account_tags (
  account_id INTEGER NOT NULL,
  tag_id     INTEGER NOT NULL,
  PRIMARY KEY (account_id, tag_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_account_tags_tag ON account_tags(tag_id);

CREATE TABLE IF NOT EXISTS push_state (
  account_id     INTEGER PRIMARY KEY,
  last_pushed_at TEXT DEFAULT '',
  updated_at     TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- 5. 自建 Cloudflare 域名收信箱 (CF Inbox Mails)
CREATE TABLE IF NOT EXISTS cf_inbox_mails (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id        TEXT DEFAULT '',
  recipient         TEXT NOT NULL,
  sender            TEXT NOT NULL,
  sender_name       TEXT DEFAULT '',
  subject           TEXT DEFAULT '',
  text_content      TEXT DEFAULT '',
  html_content      TEXT DEFAULT '',
  raw_size          INTEGER DEFAULT 0,
  verification_code TEXT DEFAULT '',
  verification_link TEXT DEFAULT '',
  dkim_status       TEXT DEFAULT 'unknown',
  spf_status        TEXT DEFAULT 'unknown',
  is_read           INTEGER DEFAULT 0,
  is_pinned         INTEGER DEFAULT 0,
  is_protected      INTEGER DEFAULT 0,
  expires_at        TEXT DEFAULT '',
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cf_recipient ON cf_inbox_mails(recipient);
CREATE INDEX IF NOT EXISTS idx_cf_sender ON cf_inbox_mails(sender);
CREATE INDEX IF NOT EXISTS idx_cf_created_at ON cf_inbox_mails(created_at);

-- 6. 平台注册资产台账表 (Platform Registration Vault)
CREATE TABLE IF NOT EXISTS platform_vault (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_name TEXT NOT NULL,
  platform_url  TEXT DEFAULT '',
  account_email TEXT NOT NULL,
  email_source  TEXT DEFAULT 'cf_domain',
  username      TEXT DEFAULT '',
  password      TEXT DEFAULT '',
  totp_secret   TEXT DEFAULT '',
  status        TEXT DEFAULT 'active',
  category      TEXT DEFAULT 'AI工具',
  proxy_node    TEXT DEFAULT '',
  remark        TEXT DEFAULT '',
  last_code     TEXT DEFAULT '',
  last_code_at  TEXT DEFAULT '',
  is_pinned     INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vault_email ON platform_vault(account_email);
CREATE INDEX IF NOT EXISTS idx_vault_platform ON platform_vault(platform_name);
CREATE INDEX IF NOT EXISTS idx_vault_category ON platform_vault(category);
CREATE INDEX IF NOT EXISTS idx_vault_status ON platform_vault(status);

-- 7. 公共临时邮箱记录 (Temp Emails)
CREATE TABLE IF NOT EXISTS temp_emails (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  source     TEXT DEFAULT 'gptmail',
  remark     TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
