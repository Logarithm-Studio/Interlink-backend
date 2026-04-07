-- 013_user_preferences.sql
-- Per-user scheduling preferences.
-- Step 13: required for conflict engine buffer support.

BEGIN;

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id               uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_buffer_minutes int         NOT NULL DEFAULT 0
                                        CHECK (default_buffer_minutes >= 0
                                           AND default_buffer_minutes <= 120),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  user_preferences IS
  'Per-user scheduling preferences (buffer minutes, future settings, …)';
COMMENT ON COLUMN user_preferences.default_buffer_minutes IS
  'Number of minutes added around each event for conflict detection. '
  '0 = detect hard overlaps only.  Max 120 (2 hours).';

COMMIT;
