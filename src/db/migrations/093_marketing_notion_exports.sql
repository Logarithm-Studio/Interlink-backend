-- Durable campaign-to-Notion-row mapping and duplicate-safe recovery state.
BEGIN;

CREATE TABLE IF NOT EXISTS sales_marketing_notion_campaign_exports (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id       uuid        NOT NULL REFERENCES sales_marketing_campaigns(id) ON DELETE CASCADE,
  data_source_id    text        NOT NULL CHECK (length(data_source_id) BETWEEN 1 AND 100),
  database_id       text        NOT NULL CHECK (length(database_id) BETWEEN 1 AND 100),
  property_mapping  jsonb       NOT NULL CHECK (jsonb_typeof(property_mapping) = 'object'),
  marker_property   text        NOT NULL CHECK (length(marker_property) BETWEEN 1 AND 100),
  status            text        NOT NULL CHECK (status IN ('creating', 'review', 'synced')),
  notion_page_id    text,
  notion_page_url   text,
  last_error_code   text CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  started_at        timestamptz NOT NULL DEFAULT now(),
  synced_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, campaign_id),
  UNIQUE (user_id, notion_page_id)
);

CREATE INDEX IF NOT EXISTS idx_marketing_notion_exports_user_updated
  ON sales_marketing_notion_campaign_exports (user_id, updated_at DESC);

ALTER TABLE sales_marketing_notion_campaign_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_notion_campaign_exports FROM anon, authenticated;

COMMIT;
