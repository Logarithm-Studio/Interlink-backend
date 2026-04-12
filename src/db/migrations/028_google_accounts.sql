-- 028_google_accounts.sql
-- Dedicated Google OAuth token table.
--
-- Tokens are encrypted by application code before insert:
-- - access_token stores access-token ciphertext
-- - refresh_token stores packed value: "iv:tag:kid:ciphertext"

BEGIN;

CREATE TABLE IF NOT EXISTS google_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  access_token    TEXT,
  refresh_token   TEXT,
  expiry_date     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reauth_required BOOLEAN NOT NULL DEFAULT FALSE,
  enc_iv          TEXT,
  enc_tag         TEXT,
  enc_kid         TEXT
);

CREATE INDEX IF NOT EXISTS idx_google_accounts_user_id
  ON google_accounts (user_id);

CREATE INDEX IF NOT EXISTS idx_google_accounts_expiry_date
  ON google_accounts (expiry_date);

-- Seed from legacy connected_accounts rows where Google is connected.
INSERT INTO google_accounts (
  user_id,
  access_token,
  refresh_token,
  expiry_date,
  created_at,
  reauth_required,
  enc_iv,
  enc_tag,
  enc_kid
)
SELECT
  ca.user_id,
  ca.access_token_enc,
  ca.refresh_token_enc,
  ca.expires_at,
  ca.created_at,
  COALESCE(ca.reauth_required, FALSE),
  ca.enc_iv,
  ca.enc_tag,
  ca.enc_kid
FROM connected_accounts ca
WHERE ca.provider = 'google'
ON CONFLICT (user_id)
DO UPDATE SET
  access_token = EXCLUDED.access_token,
  refresh_token = EXCLUDED.refresh_token,
  expiry_date = EXCLUDED.expiry_date,
  reauth_required = EXCLUDED.reauth_required,
  enc_iv = EXCLUDED.enc_iv,
  enc_tag = EXCLUDED.enc_tag,
  enc_kid = EXCLUDED.enc_kid;

COMMIT;
