BEGIN;

CREATE TABLE IF NOT EXISTS workflow_executions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  uuid        NOT NULL REFERENCES workflows(id),
  user_id      uuid        NOT NULL REFERENCES users(id),
  status       text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','running','waiting','completed','failed')),
  context      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  current_step text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_user_id
  ON workflow_executions (user_id);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_status
  ON workflow_executions (status)
  WHERE status IN ('pending', 'running', 'waiting');

CREATE TABLE IF NOT EXISTS workflow_execution_steps (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid        NOT NULL REFERENCES workflow_executions(id),
  step_id      text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','running','waiting','completed','failed')),
  attempt      int         NOT NULL DEFAULT 0,
  input        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  output       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error        jsonb,
  started_at   timestamptz,
  finished_at  timestamptz,
  next_run_at  timestamptz,
  UNIQUE (execution_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_execution_steps_execution_id
  ON workflow_execution_steps (execution_id);

COMMIT;
