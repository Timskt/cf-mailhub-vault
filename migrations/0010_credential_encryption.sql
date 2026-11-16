-- Add a keyed equality index so token refresh CAS survives randomized encryption.
ALTER TABLE accounts ADD COLUMN refresh_token_fingerprint TEXT NOT NULL DEFAULT '';
