BEGIN;

-- Professional Mode (Accountant) — invoices / accounts-receivable ledger.
-- Seeded per-user via POST /api/v1/accountant/seed-demo for iteration 1; real
-- QuickBooks/Stripe/Plaid adapters can populate the same table later.

CREATE TABLE IF NOT EXISTS invoices (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_number  text        NOT NULL,
  client_name     text        NOT NULL,
  client_email    text        NOT NULL,
  amount_cents    bigint      NOT NULL CHECK (amount_cents >= 0),
  currency        text        NOT NULL DEFAULT 'USD',
  issue_date      date        NOT NULL,
  due_date        date        NOT NULL,
  status          text        NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'overdue', 'reminded', 'paid')),
  last_reminder_at timestamptz,
  reminder_count  integer     NOT NULL DEFAULT 0,
  source          text        NOT NULL DEFAULT 'demo',
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- A user shouldn't have two rows for the same invoice number (keeps seed idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_user_number
  ON invoices (user_id, invoice_number);

CREATE INDEX IF NOT EXISTS idx_invoices_user_status_due
  ON invoices (user_id, status, due_date);

COMMIT;
