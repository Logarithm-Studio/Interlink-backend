BEGIN;

CREATE TABLE IF NOT EXISTS ai_outputs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid        REFERENCES workflow_executions(id),
  output_type  text        NOT NULL,
  content      jsonb       NOT NULL,
  model        text,
  provider     text,
  latency_ms   int,
  is_fallback  boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_outputs_execution_id
  ON ai_outputs (execution_id)
  WHERE execution_id IS NOT NULL;

COMMIT;
