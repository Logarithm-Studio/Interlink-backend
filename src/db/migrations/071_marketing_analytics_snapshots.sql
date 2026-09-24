-- Read-only, user-selected Google Analytics and Search Console snapshots.
CREATE TABLE IF NOT EXISTS sales_marketing_analytics_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('ga4', 'search_console')),
  account_ref text NOT NULL,
  account_name text NOT NULL,
  range_start date NOT NULL,
  range_end date NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (range_start <= range_end),
  UNIQUE (user_id, provider, account_ref, range_start, range_end)
);

CREATE INDEX IF NOT EXISTS idx_marketing_analytics_snapshots_recent
  ON sales_marketing_analytics_snapshots(user_id, fetched_at DESC);

ALTER TABLE sales_marketing_analytics_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_analytics_snapshots FROM anon, authenticated;
