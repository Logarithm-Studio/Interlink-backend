-- 003_events.sql
-- Normalized calendar events (extensible event_type)

CREATE TABLE IF NOT EXISTS events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_event_id TEXT NOT NULL,
  provider          TEXT NOT NULL,                      -- 'google' | 'microsoft'
  event_type        TEXT NOT NULL DEFAULT 'general',    -- extensible: 'pt_meeting', 'class', 'exam', etc.
  title             TEXT NOT NULL,
  description       TEXT,
  start_time        TIMESTAMPTZ NOT NULL,
  end_time          TIMESTAMPTZ NOT NULL,
  organizer_email   TEXT,
  attendees         JSONB DEFAULT '[]'::jsonb,
  is_recurring      BOOLEAN DEFAULT FALSE,
  metadata          JSONB DEFAULT '{}'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, external_event_id, provider)
);

-- Index for time-range queries (conflict detection, event listing)
CREATE INDEX IF NOT EXISTS idx_events_user_time
  ON events (user_id, start_time, end_time);

-- Index for deduplication during sync
CREATE INDEX IF NOT EXISTS idx_events_external
  ON events (external_event_id, provider);
