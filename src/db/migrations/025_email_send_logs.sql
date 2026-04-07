BEGIN;

CREATE TABLE IF NOT EXISTS email_send_logs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id         uuid        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  template_id      text,
  recipients       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  subject          text        NOT NULL,
  body             text        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('sent', 'already_sent', 'failed')),
  gmail_message_id text,
  failure_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_send_logs_user_event_created
  ON email_send_logs (user_id, event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_send_logs_status
  ON email_send_logs (status);

COMMIT;
