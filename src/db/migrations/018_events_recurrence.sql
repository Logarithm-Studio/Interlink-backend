-- 018_events_recurrence.sql
-- Add recurrence tracking columns to the events table.
--
-- series_id    — the provider's series / recurring event master ID.
--               For Google: recurringEventId (the master event's ID).
--               For Microsoft: the series master ID from Graph.
--               NULL for non-recurring events.
--
-- occurrence_id — provider-specific identifier for this particular occurrence
--               within a series (e.g. the event's own id when it is an
--               exception instance, or the original start time encoded as a
--               string for regular occurrences).
--               NULL for non-recurring events.
--
-- These columns let the conflict engine work on occurrence instances while
-- still being able to group them by series.

BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS series_id     TEXT,
  ADD COLUMN IF NOT EXISTS occurrence_id TEXT;

-- Index to look up all occurrences in a series efficiently.
CREATE INDEX IF NOT EXISTS idx_events_series_id
  ON events (user_id, series_id)
  WHERE series_id IS NOT NULL;

COMMIT;
