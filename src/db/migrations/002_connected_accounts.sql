-- 002_connected_accounts.sql
-- Store OAuth tokens per provider (Google, Microsoft)

CREATE TABLE IF NOT EXISTS connected_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,                        -- 'google' | 'microsoft'
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_connected_accounts_user
  ON connected_accounts (user_id);
