BEGIN;

-- Track when an invoice was actually paid, so the dunning engine + AR insights
-- can reason about each client's payment behaviour ("pays ~N days late").

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_invoices_user_paid_at
  ON invoices (user_id, paid_at);

COMMIT;
