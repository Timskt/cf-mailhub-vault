ALTER TABLE cf_inbox_mails ADD COLUMN raw_object_key TEXT NOT NULL DEFAULT '';
ALTER TABLE cf_inbox_mails ADD COLUMN attachment_manifest TEXT NOT NULL DEFAULT '[]';
CREATE INDEX idx_cf_raw_object ON cf_inbox_mails(raw_object_key);
CREATE TABLE mail_object_gc (
  key TEXT PRIMARY KEY,
  available_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_mail_object_gc_due ON mail_object_gc(available_at);
