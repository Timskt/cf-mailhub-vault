-- Optional managed datasets. The original tables remain readable and unchanged.
CREATE TABLE storage_meta (
  generation TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT '',
  counters TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO storage_meta(generation) VALUES ('legacy');
CREATE TABLE storage_rows (
  generation TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY(generation, table_name, row_key)
);
-- A failing guard aborts the whole D1 batch, including the data changes.
CREATE TABLE storage_guard (value INTEGER NOT NULL CHECK (value = 1));
