BEGIN;

-- Professional Mode (Accountant) — Expense Auditing ledger.
-- Seeded per-user via POST /accountant/seed-demo. Gemini reviews these rows and
-- flags duplicates / missing receipts / policy violations / miscategorizations.

CREATE TABLE IF NOT EXISTS expenses (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant      text        NOT NULL,
  amount_cents  bigint      NOT NULL CHECK (amount_cents >= 0),
  currency      text        NOT NULL DEFAULT 'USD',
  txn_date      date        NOT NULL,
  category      text,
  card_last4    text,
  has_receipt   boolean     NOT NULL DEFAULT true,
  status        text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'flagged', 'approved', 'dismissed')),
  flag_reason   text,
  ai_analysis   jsonb,
  source        text        NOT NULL DEFAULT 'demo',
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Keep the demo seed idempotent per (user, merchant, amount, date).
CREATE UNIQUE INDEX IF NOT EXISTS uq_expenses_user_seed
  ON expenses (user_id, merchant, amount_cents, txn_date);

CREATE INDEX IF NOT EXISTS idx_expenses_user_status_date
  ON expenses (user_id, status, txn_date DESC);

COMMIT;
