-- Opt-in daily read-back for directly published social posts.
BEGIN;

CREATE TABLE IF NOT EXISTS sales_marketing_post_monitor_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  providers text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_run_at timestamptz,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(last_result) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(providers) <= 3),
  CHECK (providers <@ ARRAY['facebook','instagram','linkedin']::text[]),
  CHECK (NOT enabled OR cardinality(providers) > 0)
);

ALTER TABLE sales_marketing_post_monitor_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_post_monitor_preferences FROM anon, authenticated;

COMMIT;
