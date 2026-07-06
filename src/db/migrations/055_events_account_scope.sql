-- 055_events_account_scope.sql
-- Tag synced events with the Google account they came from, so the events view
-- can be filtered to the active mode's account (Personal vs Work calendar).

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS google_account_id UUID
    REFERENCES google_accounts(id) ON DELETE CASCADE;

-- Backfill existing events to each user's primary Google account.
UPDATE events e
   SET google_account_id = ga.id
  FROM google_accounts ga
 WHERE ga.user_id = e.user_id
   AND ga.is_primary = TRUE
   AND e.google_account_id IS NULL;

-- The same external event id can now exist under two different accounts, so the
-- dedup key gains the account dimension. Replace the old 3-column constraint.
ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_user_id_external_event_id_provider_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_events_user_ext_provider_account
  ON events (user_id, external_event_id, provider, google_account_id);

CREATE INDEX IF NOT EXISTS idx_events_account_time
  ON events (google_account_id, start_time);
