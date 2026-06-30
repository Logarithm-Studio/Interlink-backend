-- Raw webhook events received from third-party integrations (Spotify, Todoist, etc.).
-- Persisted before processing so any failures can be replayed.
CREATE TABLE integration_webhook_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  provider     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_integration_webhook_provider ON integration_webhook_events(provider, created_at DESC);
CREATE INDEX idx_integration_webhook_unprocessed ON integration_webhook_events(provider) WHERE processed_at IS NULL;
