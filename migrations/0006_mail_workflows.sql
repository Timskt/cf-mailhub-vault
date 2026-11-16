-- Additive upgrade: existing messages remain in the inbox with their original content.
ALTER TABLE cf_inbox_mails ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cf_inbox_mails ADD COLUMN category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE cf_inbox_mails ADD COLUMN rule_name TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_cf_folder_category ON cf_inbox_mails(is_archived, category, created_at DESC);

CREATE TABLE mail_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  sender_contains TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  subject_contains TEXT NOT NULL DEFAULT '',
  verification_only INTEGER NOT NULL DEFAULT 0,
  action_category TEXT NOT NULL DEFAULT '',
  mark_read INTEGER NOT NULL DEFAULT 0,
  archive INTEGER NOT NULL DEFAULT 0,
  pin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_mail_rules_order ON mail_rules(enabled, priority, id);
