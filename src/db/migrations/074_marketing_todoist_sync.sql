-- Persist Todoist task links so marketers can reconcile completed follow-ups safely.
BEGIN;

ALTER TABLE sales_marketing_followups
  ADD COLUMN todoist_task_id text,
  ADD COLUMN todoist_synced_at timestamptz;

CREATE UNIQUE INDEX idx_marketing_followups_todoist_task
  ON sales_marketing_followups(user_id, todoist_task_id)
  WHERE todoist_task_id IS NOT NULL;

COMMIT;
