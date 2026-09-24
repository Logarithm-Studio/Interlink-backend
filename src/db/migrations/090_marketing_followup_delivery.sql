-- Opt-in email/push delivery for a marketer's own due follow-up reminders.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_followups_id_user
  ON sales_marketing_followups (id, user_id);

CREATE TABLE IF NOT EXISTS sales_marketing_followup_reminder_preferences (
  user_id       uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_enabled  boolean     NOT NULL DEFAULT false,
  email_enabled boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_marketing_followup_reminder_deliveries (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followup_id         uuid        NOT NULL,
  reminder_at         timestamptz NOT NULL,
  channel             text        NOT NULL CHECK (channel IN ('push', 'email')),
  status              text        NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'review')),
  error_code          text        CHECK (error_code IS NULL OR length(error_code) <= 64),
  provider_message_id text        CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 512),
  attempted_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (followup_id, reminder_at, channel),
  FOREIGN KEY (followup_id, user_id)
    REFERENCES sales_marketing_followups(id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_marketing_followup_reminder_deliveries_user_time
  ON sales_marketing_followup_reminder_deliveries (user_id, reminder_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_followup_reminder_deliveries_followup_user
  ON sales_marketing_followup_reminder_deliveries (followup_id, user_id);

ALTER TABLE sales_marketing_followup_reminder_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_marketing_followup_reminder_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_followup_reminder_preferences,
  sales_marketing_followup_reminder_deliveries FROM anon, authenticated;

COMMIT;
