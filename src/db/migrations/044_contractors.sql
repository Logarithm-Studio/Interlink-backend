BEGIN;

-- Professional Mode (Accountant) — Tax Document Gathering.
-- Contractors with year-to-date pay; W-9 status drives the request workflow.

CREATE TABLE IF NOT EXISTS contractors (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  email           text        NOT NULL,
  ytd_paid_cents  bigint      NOT NULL DEFAULT 0,
  w9_status       text        NOT NULL DEFAULT 'missing'
                    CHECK (w9_status IN ('missing', 'requested', 'received', 'filed')),
  last_request_at timestamptz,
  source          text        NOT NULL DEFAULT 'demo',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_contractors_user_status
  ON contractors (user_id, w9_status);

COMMIT;
