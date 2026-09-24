-- Keep an immutable content snapshot for every saved edit and record each
-- content lifecycle event alongside its state change.
BEGIN;

ALTER TABLE sales_marketing_approval_events
  DROP CONSTRAINT IF EXISTS sales_marketing_approval_events_action_check;

ALTER TABLE sales_marketing_approval_events
  ADD CONSTRAINT sales_marketing_approval_events_action_check
    CHECK (action IN ('created','edited','submitted','approved','rejected','scheduled','published','completed','sent','cancelled','reconciled'));

CREATE TABLE IF NOT EXISTS sales_marketing_content_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_id uuid NOT NULL REFERENCES sales_marketing_content_items(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','instagram','facebook','linkedin','youtube','blog','landing_page','search','ad','influencer','event','other')),
  body text NOT NULL,
  asset_url text,
  scheduled_at timestamptz,
  saved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, version)
);

CREATE INDEX IF NOT EXISTS idx_marketing_content_revisions_history
  ON sales_marketing_content_revisions(user_id, content_id, version DESC);

INSERT INTO sales_marketing_content_revisions
  (user_id,content_id,version,title,channel,body,asset_url,scheduled_at,saved_at)
SELECT user_id,id,1,title,channel,body,asset_url,scheduled_at,created_at
  FROM sales_marketing_content_items
ON CONFLICT (content_id,version) DO NOTHING;

ALTER TABLE sales_marketing_content_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_content_revisions FROM anon, authenticated;

COMMIT;
