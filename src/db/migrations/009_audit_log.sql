BEGIN;

CREATE TABLE IF NOT EXISTS audit_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        REFERENCES users(id),
  actor_type      text        NOT NULL CHECK (actor_type IN ('api', 'worker', 'system')),
  action          text        NOT NULL,
  entity_type     text,
  entity_id       uuid,
  idempotency_key text,
  request_id      text,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Durable dedupe: prevents the same side effect from being recorded twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_idempotency_key
  ON audit_log (action, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_user_id
  ON audit_log (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON audit_log (entity_type, entity_id)
  WHERE entity_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
  ON audit_log (created_at DESC);

COMMIT;
