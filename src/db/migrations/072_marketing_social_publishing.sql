-- Persist direct social publish state so a timed-out request cannot be retried blindly.
BEGIN;

ALTER TABLE sales_marketing_content_items
  DROP CONSTRAINT IF EXISTS sales_marketing_content_items_status_check;

ALTER TABLE sales_marketing_content_items
  ADD CONSTRAINT sales_marketing_content_items_status_check
    CHECK (status IN ('draft','in_review','approved','planned','publishing','publish_review','published','completed','cancelled')),
  ADD COLUMN IF NOT EXISTS provider_target_id text,
  ADD COLUMN IF NOT EXISTS provider_target_name text;

ALTER TABLE sales_marketing_approval_events
  DROP CONSTRAINT IF EXISTS sales_marketing_approval_events_action_check;

ALTER TABLE sales_marketing_approval_events
  ADD CONSTRAINT sales_marketing_approval_events_action_check
    CHECK (action IN ('created','edited','submitted','approved','rejected','scheduled','publish_started','publish_review','publish_retried','published','completed','sent','cancelled','reconciled'));

COMMIT;
