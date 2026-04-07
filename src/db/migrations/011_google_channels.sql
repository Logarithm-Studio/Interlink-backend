BEGIN;

CREATE TABLE IF NOT EXISTS google_watch_channels (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id    text        NOT NULL UNIQUE,
  resource_id   text        NOT NULL,
  channel_token text        NOT NULL,
  calendar_id   text        NOT NULL DEFAULT 'primary',
  expiration    timestamptz NOT NULL,
  sync_token    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gwc_user_id    ON google_watch_channels(user_id);
CREATE INDEX IF NOT EXISTS idx_gwc_expiration ON google_watch_channels(expiration);

COMMIT;
