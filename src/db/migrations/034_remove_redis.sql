-- Migration 034: Remove Redis dependencies
-- Replaces Redis-backed OAuth state and webhook dedup with PostgreSQL tables.
-- Run this in the Supabase SQL editor or via the migration runner.

-- OAuth state tokens (replaces Redis oauth:state:* keys)
CREATE TABLE IF NOT EXISTS oauth_states (
  token                text        PRIMARY KEY,
  user_id              uuid        NOT NULL,
  provider             text        NOT NULL,
  success_redirect_uri text,
  error_redirect_uri   text,
  expires_at           timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_idx ON oauth_states (expires_at);

-- Webhook deduplication (replaces Redis webhook:google:* keys with 48h TTL)
CREATE TABLE IF NOT EXISTS webhook_dedup (
  dedup_key  text        PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_dedup_expires_idx ON webhook_dedup (expires_at);
