-- Keep a bounded, user-scoped history of provider read-backs for published social posts.
BEGIN;

CREATE TABLE IF NOT EXISTS sales_marketing_post_metrics_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_item_id uuid NOT NULL REFERENCES sales_marketing_content_items(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('facebook', 'instagram', 'linkedin')),
  provider_post_id text NOT NULL,
  provider_state text NOT NULL CHECK (provider_state IN ('live', 'not_published')),
  provider_url text CHECK (provider_url IS NULL OR provider_url ~* '^https://'),
  provider_published_at timestamptz,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_post_metrics_latest
  ON sales_marketing_post_metrics_snapshots(user_id, content_item_id, checked_at DESC, id DESC);

ALTER TABLE sales_marketing_post_metrics_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_post_metrics_snapshots FROM anon, authenticated;

ALTER TABLE sales_marketing_approval_events
  DROP CONSTRAINT IF EXISTS sales_marketing_approval_events_action_check;

ALTER TABLE sales_marketing_approval_events
  ADD CONSTRAINT sales_marketing_approval_events_action_check
    CHECK (action IN ('created','edited','submitted','approved','rejected','scheduled','publish_started','publish_review','publish_retried','published','completed','sent','cancelled','reconciled','provider_checked'));

COMMIT;
