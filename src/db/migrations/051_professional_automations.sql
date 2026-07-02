BEGIN;

-- Per-persona autonomy: scheduled Suggest/Auto automations for the non-finance
-- professional personas (mirrors accountant_automations, but keyed by persona).

CREATE TABLE IF NOT EXISTS professional_automations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona     text        NOT NULL,
  type        text        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT true,
  autonomy    text        NOT NULL DEFAULT 'suggest'
                CHECK (autonomy IN ('off', 'suggest', 'auto')),
  config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  guardrails  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, persona, type)
);

CREATE INDEX IF NOT EXISTS idx_professional_automations_user
  ON professional_automations (user_id, persona);

CREATE INDEX IF NOT EXISTS idx_professional_automations_active
  ON professional_automations (enabled, autonomy);

COMMIT;
