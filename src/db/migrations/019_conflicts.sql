-- 019_conflicts.sql
-- Persistent conflict registry — §7.6
--
-- Upgrades conflicts from ephemeral query results to first-class entities with:
--   • A stable UUID per (user, eventA, eventB) pair — referenced by workflow
--     executions, notification action tokens, and the API.
--   • Lifecycle status: active | cleared — enables change-tracking and
--     "cleared conflict" triggers.
--   • Full history via first_detected_at / last_detected_at / cleared_at.
--
-- Dedup key: (user_id, event_a_id, event_b_id) — always stored with
--   event_a_id < event_b_id (enforced by the service layer) so insertion
--   order doesn't create duplicate rows.

BEGIN;

CREATE TABLE IF NOT EXISTS conflicts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  event_a_id        uuid        NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
  event_b_id        uuid        NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
  conflict_type     text        NOT NULL CHECK (conflict_type IN ('overlap', 'buffer_violation')),
  severity          text        NOT NULL CHECK (severity        IN ('low', 'medium', 'high')),
  overlap_minutes   int         NOT NULL DEFAULT 0,
  status            text        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'cleared')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at  timestamptz NOT NULL DEFAULT now(),
  cleared_at        timestamptz,

  -- Canonical ordering: event_a_id < event_b_id (UUIDs compared as text)
  CONSTRAINT conflicts_pair_order CHECK (event_a_id < event_b_id),
  CONSTRAINT conflicts_pair_unique UNIQUE (user_id, event_a_id, event_b_id)
);

COMMENT ON TABLE conflicts IS
  'Persistent conflict registry.  Each row is a (user, eventA, eventB) pair '
  'with a stable UUID and lifecycle status (active | cleared).';

COMMENT ON COLUMN conflicts.status IS
  'active = pair still overlaps on the last detection pass; '
  'cleared = no longer overlapping.';

COMMENT ON COLUMN conflicts.event_a_id IS
  'Always the smaller UUID of the pair (event_a_id < event_b_id).';

-- Fast lookup of all active conflicts for a user (API + workflow queries)
CREATE INDEX IF NOT EXISTS idx_conflicts_user_active
  ON conflicts (user_id, status)
  WHERE status = 'active';

-- Fast cascade check when looking up by either event ID
CREATE INDEX IF NOT EXISTS idx_conflicts_event_b
  ON conflicts (event_b_id);

COMMIT;
