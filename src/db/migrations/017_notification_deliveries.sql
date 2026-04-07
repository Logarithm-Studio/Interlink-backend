BEGIN;

-- Stores FCM/web-push device tokens registered by users' mobile/web clients.
-- A user can have multiple tokens (multiple devices).
CREATE TABLE IF NOT EXISTS push_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       text        NOT NULL,
  platform    text        NOT NULL DEFAULT 'unknown', -- 'ios' | 'android' | 'web'
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens (user_id);

-- Delivery audit trail for every notification attempt.
-- One row per channel attempt (push / email_fallback).
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id         uuid        REFERENCES workflow_executions(id),
  step_id              text        NOT NULL,
  user_id              uuid        NOT NULL REFERENCES users(id),
  channel              text        NOT NULL, -- 'push' | 'email_fallback'
  status               text        NOT NULL, -- 'sent' | 'failed' | 'skipped'
  -- Deterministic key prevents duplicate delivery rows on BullMQ retries.
  idempotency_key      text        NOT NULL,
  provider_message_id  text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_deliveries_idem
  ON notification_deliveries (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_execution
  ON notification_deliveries (execution_id)
  WHERE execution_id IS NOT NULL;

COMMIT;
