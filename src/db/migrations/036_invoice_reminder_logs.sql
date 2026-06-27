BEGIN;

-- Explicit per-invoice dunning send log (mirrors email_send_logs, but kept
-- separate so Professional-Mode data never touches the Personal-Mode table).

CREATE TABLE IF NOT EXISTS invoice_reminder_logs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id          uuid        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  recipients          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  subject             text        NOT NULL,
  body                text        NOT NULL,
  status              text        NOT NULL CHECK (status IN ('sent', 'already_sent', 'failed')),
  provider_message_id text,
  is_ai_fallback      boolean     NOT NULL DEFAULT false,
  failure_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_reminder_logs_user_invoice_created
  ON invoice_reminder_logs (user_id, invoice_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_reminder_logs_status
  ON invoice_reminder_logs (status);

COMMIT;
