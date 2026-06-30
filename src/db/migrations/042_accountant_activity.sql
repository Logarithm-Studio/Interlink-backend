BEGIN;

-- Agent activity feed — a user-facing log of everything the agent does, plus
-- "suggested" items (Suggest-mode) awaiting one-tap approval.

CREATE TABLE IF NOT EXISTS accountant_activity (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text        NOT NULL,             -- reminder_sent, reminder_suggested, audit_run, report_emailed, agent_action, ...
  title       text        NOT NULL,
  detail      text,
  entity_type text,                              -- invoice | expense | report | contractor
  entity_id   text,
  status      text        NOT NULL DEFAULT 'done'
                CHECK (status IN ('done', 'suggested', 'failed', 'dismissed')),
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- pending-action params for 'suggested'
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accountant_activity_user_created
  ON accountant_activity (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_accountant_activity_user_status
  ON accountant_activity (user_id, status);

COMMIT;
