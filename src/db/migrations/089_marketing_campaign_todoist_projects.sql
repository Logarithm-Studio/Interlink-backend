-- Let each campaign route new follow-up copies to its matching Todoist project.
-- Existing linked tasks are never moved when a campaign mapping changes.
BEGIN;

ALTER TABLE sales_marketing_campaigns
  ADD COLUMN IF NOT EXISTS todoist_project_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'sales_marketing_campaigns_todoist_project_id_length'
       AND conrelid = 'sales_marketing_campaigns'::regclass
  ) THEN
    ALTER TABLE sales_marketing_campaigns
      ADD CONSTRAINT sales_marketing_campaigns_todoist_project_id_length
      CHECK (todoist_project_id IS NULL OR length(todoist_project_id) BETWEEN 1 AND 100);
  END IF;
END $$;

COMMIT;
