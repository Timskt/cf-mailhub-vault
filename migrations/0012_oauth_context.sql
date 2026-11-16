-- Bind authorization to the intended account and public/confidential client flow.
-- Existing in-flight sessions are invalidated safely by their empty context.
ALTER TABLE oauth_sessions ADD COLUMN context TEXT NOT NULL DEFAULT '{}';
