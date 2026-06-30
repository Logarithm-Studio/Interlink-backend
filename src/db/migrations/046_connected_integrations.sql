-- Generic OAuth token storage for all third-party integrations beyond Google.
-- Tokens are stored as packed strings: iv:tag:kid:ciphertext (same crypto as connected_accounts).
-- provider values: 'spotify', 'todoist', 'notion', 'trello', 'github', 'hubspot', 'mailchimp', etc.
CREATE TABLE connected_integrations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL,
  access_token_packed   TEXT,
  refresh_token_packed  TEXT,
  token_expires_at      TIMESTAMPTZ,
  scopes                TEXT[],
  metadata              JSONB NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'expired', 'revoked', 'reauth_required')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE INDEX idx_connected_integrations_user ON connected_integrations(user_id);
CREATE INDEX idx_connected_integrations_provider ON connected_integrations(user_id, provider);
