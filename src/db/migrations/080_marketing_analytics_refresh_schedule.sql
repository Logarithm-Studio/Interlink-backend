-- User-selected, read-only daily refresh settings for normalized Marketing analytics.
BEGIN;

CREATE TABLE IF NOT EXISTS sales_marketing_analytics_refresh_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  targets jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(targets) = 'object'),
  range_days smallint NOT NULL DEFAULT 30 CHECK (range_days IN (30, 90)),
  last_run_at timestamptz,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(last_result) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sales_marketing_analytics_refresh_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_analytics_refresh_preferences FROM anon, authenticated;

COMMIT;
