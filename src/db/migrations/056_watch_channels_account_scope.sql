-- 056_watch_channels_account_scope.sql
-- Each Google account gets its own calendar watch channel + incremental sync
-- cursor, so tag google_watch_channels with the owning account.

ALTER TABLE google_watch_channels
  ADD COLUMN IF NOT EXISTS google_account_id UUID
    REFERENCES google_accounts(id) ON DELETE CASCADE;

-- Backfill existing channels to each user's primary Google account.
UPDATE google_watch_channels wc
   SET google_account_id = ga.id
  FROM google_accounts ga
 WHERE ga.user_id = wc.user_id
   AND ga.is_primary = TRUE
   AND wc.google_account_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_gwc_account_id
  ON google_watch_channels (google_account_id);
