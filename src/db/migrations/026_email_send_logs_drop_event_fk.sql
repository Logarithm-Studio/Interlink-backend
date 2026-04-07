BEGIN;

ALTER TABLE email_send_logs
  DROP CONSTRAINT IF EXISTS email_send_logs_event_id_fkey;

COMMIT;
