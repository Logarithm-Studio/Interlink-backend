-- 010_connected_accounts_encryption.sql
-- Add application-layer AES-256-GCM encrypted token columns and reauth flag.
--
-- Strategy:
--   • Add nullable encrypted columns (*_enc, enc_iv, enc_tag, enc_kid).
--   • Add reauth_required boolean (default false).
--   • Make the plaintext token columns nullable (new writes omit them).
--   • Mark every existing row as reauth_required because plaintext tokens
--     cannot be encrypted server-side without a running Node process.
--     Users will be prompted to reconnect; on reconnect the encrypted columns
--     are populated automatically by auth.service.ts.
--   • Null out plaintext tokens on existing rows so legacy values are not
--     readable after this migration ships.

BEGIN;

-- 1. Add encrypted storage columns (nullable — populated by application code)
ALTER TABLE connected_accounts
  ADD COLUMN IF NOT EXISTS access_token_enc  TEXT,
  ADD COLUMN IF NOT EXISTS refresh_token_enc TEXT,
  ADD COLUMN IF NOT EXISTS enc_iv            TEXT,
  ADD COLUMN IF NOT EXISTS enc_tag           TEXT,
  ADD COLUMN IF NOT EXISTS enc_kid           TEXT;

-- 2. Add reauth flag
ALTER TABLE connected_accounts
  ADD COLUMN IF NOT EXISTS reauth_required   BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Make plaintext columns nullable for new writes (must happen before we null them)
ALTER TABLE connected_accounts
  ALTER COLUMN access_token  DROP NOT NULL,
  ALTER COLUMN refresh_token DROP NOT NULL;

-- 4. Mark existing rows as requiring re-authentication and null plaintext tokens
UPDATE connected_accounts
   SET reauth_required    = TRUE,
       access_token       = NULL,
       refresh_token      = NULL
 WHERE access_token IS NOT NULL
    OR refresh_token IS NOT NULL;

COMMIT;
