-- 033_reminder_lead_minutes.sql
-- Per-user lead time (in minutes) for local event-reminder notifications.
-- Consumed by the reminder planner to compute when the device should fire
-- a local notification ahead of each event.

BEGIN;

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS reminder_lead_minutes integer NOT NULL DEFAULT 15
    CHECK (reminder_lead_minutes >= 0 AND reminder_lead_minutes <= 240);

COMMENT ON COLUMN user_preferences.reminder_lead_minutes IS
  'Minutes before an event (plus driving ETA) to fire the local reminder '
  'notification on the user device. Default 15.';

COMMIT;
