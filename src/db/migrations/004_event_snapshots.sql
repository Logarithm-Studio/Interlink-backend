-- 004_event_snapshots.sql
-- Immutable audit trail for event changes (conflict auditing)

CREATE TABLE IF NOT EXISTS event_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  snapshot    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_snapshots_event
  ON event_snapshots (event_id, created_at DESC);
