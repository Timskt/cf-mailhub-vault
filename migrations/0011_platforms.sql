-- Independent platform catalog. Existing account names are adopted as catalog entries.
CREATE TABLE IF NOT EXISTS platforms (
  name_key    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT DEFAULT '',
  category    TEXT DEFAULT '其他',
  remark      TEXT DEFAULT '',
  is_pinned   INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_platforms_name ON platforms(name);

INSERT OR IGNORE INTO platforms(name_key, name, url, category, remark, is_pinned, created_at, updated_at)
SELECT lower(trim(platform_name)), trim(platform_name),
       CASE WHEN lower(platform_url) LIKE 'https://%' OR lower(platform_url) LIKE 'http://%' THEN platform_url ELSE '' END,
       coalesce(nullif(category, ''), '其他'), '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM platform_vault
WHERE id IN (
  SELECT min(id) FROM platform_vault
  WHERE trim(platform_name) <> ''
  GROUP BY lower(trim(platform_name))
);
