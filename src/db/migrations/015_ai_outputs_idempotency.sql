BEGIN;

-- Add a top-level idempotency_key to ai_outputs so the AI service can
-- look up prior results without scanning the JSONB content column.
-- Using ADD COLUMN IF NOT EXISTS for idempotency (re-runnable).
ALTER TABLE ai_outputs
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Partial unique index: one persisted output per idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_outputs_idempotency_key
  ON ai_outputs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Covering index for the lookup pattern used by ai.service.ts:
-- SELECT … FROM ai_outputs WHERE execution_id = $1 AND idempotency_key = $2
CREATE INDEX IF NOT EXISTS idx_ai_outputs_idem_exec
  ON ai_outputs (execution_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
