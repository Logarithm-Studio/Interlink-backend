-- Let marketers choose the Todoist destination for newly exported follow-ups.
BEGIN;

CREATE TABLE IF NOT EXISTS sales_marketing_todoist_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  project_id text CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sales_marketing_todoist_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_todoist_preferences FROM anon, authenticated;

COMMIT;
