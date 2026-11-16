-- Portable schema fields are mirrored in src/storage/model.ts by the integrating change.
-- These native tables serve the original D1 dataset; writes still go through db().mutate().
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  restrictions TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT '',
  last_used_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_api_keys_created ON api_keys(created_at, id);

CREATE TABLE idempotency_requests (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  route TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'in_progress',
  response_status INTEGER NOT NULL DEFAULT 0,
  response_headers TEXT NOT NULL DEFAULT '{}',
  response_ciphertext TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_idempotency_expiry ON idempotency_requests(expires_at, id);
CREATE INDEX idx_idempotency_actor ON idempotency_requests(actor, created_at);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL DEFAULT '',
  api_key_prefix TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  resource TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_audit_created ON audit_logs(created_at, id);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at);
CREATE INDEX idx_audit_actor ON audit_logs(actor_type, actor_id, created_at);
