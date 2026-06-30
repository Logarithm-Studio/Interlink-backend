BEGIN;

-- Professional Mode (Accountant) — automation rules with autonomy + guardrails.
-- One row per (user, type). The scheduled runner evaluates these.

CREATE TABLE IF NOT EXISTS accountant_automations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text        NOT NULL
                CHECK (type IN ('dunning_sequence', 'expense_audit', 'flash_report', 'tax_docs')),
  enabled     boolean     NOT NULL DEFAULT true,
  autonomy    text        NOT NULL DEFAULT 'suggest'
                CHECK (autonomy IN ('off', 'suggest', 'auto')),
  config      jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- e.g. cadence days
  guardrails  jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- dailySendCap, businessHours, maxEscalation
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, type)
);

CREATE INDEX IF NOT EXISTS idx_accountant_automations_user
  ON accountant_automations (user_id);

COMMIT;
