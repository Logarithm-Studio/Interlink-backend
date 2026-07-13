-- Composio-brokered integrations (HubSpot, Salesforce, Stripe, Zendesk, Zoom, Linear, ...).
--
-- Deliberately NOT stored in connected_integrations: that table exists to hold encrypted
-- OAuth tokens (access_token_packed / refresh_token_packed). For Composio-brokered apps we
-- hold NO tokens at all — Composio owns the OAuth app and the credentials. All we keep is a
-- pointer (connected_account_id) so we can scope tool loading and revoke the connection.
-- A separate table makes that "we store no secrets here" property explicit.
CREATE TABLE IF NOT EXISTS composio_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Composio toolkit slug, lowercase (e.g. 'hubspot', 'linear', 'stripe').
  toolkit_slug          TEXT NOT NULL,
  -- Composio's connected-account nanoid. Null between initiating the OAuth redirect and
  -- the connection going ACTIVE (we reconcile from Composio on the next read).
  connected_account_id  TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'active', 'failed', 'revoked')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, toolkit_slug)
);

CREATE INDEX IF NOT EXISTS idx_composio_connections_user
  ON composio_connections(user_id);
-- The agent's hot path: "which toolkits do I load tools for on this turn?"
CREATE INDEX IF NOT EXISTS idx_composio_connections_active
  ON composio_connections(user_id, status)
  WHERE status = 'active';
