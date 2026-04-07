BEGIN;

CREATE TABLE IF NOT EXISTS workflows (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  trigger_type text        NOT NULL,
  definition   jsonb       NOT NULL,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflows_trigger_type_active
  ON workflows (trigger_type)
  WHERE is_active = true;

COMMIT;
