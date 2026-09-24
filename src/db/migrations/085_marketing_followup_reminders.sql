-- Per-follow-up reminders delivered to the Interlink Notification Hub.
BEGIN;

ALTER TABLE sales_marketing_followups
  ADD COLUMN IF NOT EXISTS reminder_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_added_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_marketing_followups_due_reminders
  ON sales_marketing_followups (reminder_at, user_id)
  WHERE status = 'open' AND reminder_at IS NOT NULL AND reminder_added_at IS NULL;

COMMIT;
