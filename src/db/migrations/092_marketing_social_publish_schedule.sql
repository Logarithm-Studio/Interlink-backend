-- Store confirmed automatic social-publishing schedules independently of QStash delivery.
-- QStash messages are a delivery mechanism; this table remains the source of truth.
BEGIN;

CREATE TABLE IF NOT EXISTS sales_marketing_social_publish_schedules (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_item_id     uuid        NOT NULL UNIQUE REFERENCES sales_marketing_content_items(id) ON DELETE CASCADE,
  generation          integer     NOT NULL DEFAULT 1 CHECK (generation > 0),
  provider            text        NOT NULL CHECK (provider IN ('facebook', 'instagram', 'linkedin')),
  target_id           text        NOT NULL CHECK (length(target_id) BETWEEN 1 AND 200),
  target_name         text        NOT NULL CHECK (length(target_name) BETWEEN 1 AND 200),
  scheduled_at        timestamptz NOT NULL,
  status              text        NOT NULL CHECK (status IN ('pending', 'dispatching', 'queued', 'publishing', 'completed', 'review', 'cancelled')),
  dispatch_claimed_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_social_publish_schedules_due
  ON sales_marketing_social_publish_schedules (scheduled_at, user_id)
  WHERE status IN ('pending', 'dispatching');

CREATE INDEX IF NOT EXISTS idx_marketing_social_publish_schedules_stale
  ON sales_marketing_social_publish_schedules (updated_at)
  WHERE status IN ('dispatching', 'publishing');

ALTER TABLE sales_marketing_approval_events
  DROP CONSTRAINT IF EXISTS sales_marketing_approval_events_action_check;

ALTER TABLE sales_marketing_approval_events
  ADD CONSTRAINT sales_marketing_approval_events_action_check
    CHECK (action IN ('created','edited','submitted','approved','rejected','scheduled','unscheduled','publish_started','publish_review','publish_retried','published','completed','sent','cancelled','reconciled','provider_checked'));

ALTER TABLE sales_marketing_social_publish_schedules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_social_publish_schedules FROM anon, authenticated;

COMMIT;
