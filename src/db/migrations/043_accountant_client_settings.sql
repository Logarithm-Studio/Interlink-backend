BEGIN;

-- Per-client overrides (guardrail: opt a client out of automated dunning).

CREATE TABLE IF NOT EXISTS accountant_client_settings (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_name   text        NOT NULL,
  dunning_paused boolean    NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_name)
);

CREATE INDEX IF NOT EXISTS idx_accountant_client_settings_user
  ON accountant_client_settings (user_id);

COMMIT;
