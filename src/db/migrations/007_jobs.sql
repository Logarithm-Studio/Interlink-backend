BEGIN;

-- Job ledger: durable record of every BullMQ job enqueued, for audit and replay.
CREATE TABLE IF NOT EXISTS jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type        text        NOT NULL,
  queue_name      text        NOT NULL,
  bullmq_job_id   text,
  idempotency_key text,
  user_id         uuid        REFERENCES users(id),
  execution_id    uuid        REFERENCES workflow_executions(id),
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status          text        NOT NULL DEFAULT 'enqueued'
                              CHECK (status IN ('enqueued','processing','completed','failed','dead')),
  attempt         int         NOT NULL DEFAULT 0,
  error           jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency_key
  ON jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_execution_id
  ON jobs (execution_id)
  WHERE execution_id IS NOT NULL;

COMMIT;
