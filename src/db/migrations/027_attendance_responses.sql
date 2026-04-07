BEGIN;

CREATE TABLE IF NOT EXISTS attendance_responses (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   uuid        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  response   text        NOT NULL CHECK (response IN ('yes', 'no')),
  handled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_responses_user_event
  ON attendance_responses (user_id, event_id);

CREATE INDEX IF NOT EXISTS idx_attendance_responses_user_handled
  ON attendance_responses (user_id, handled_at DESC);

COMMIT;
