-- Explicit, per-workspace HubSpot pipeline-stage and owner mappings.
BEGIN;

CREATE TABLE IF NOT EXISTS sales_marketing_hubspot_preferences (
  user_id        uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pipeline_id    text,
  stage_mappings jsonb       NOT NULL DEFAULT '{}'::jsonb,
  owner_mappings jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (pipeline_id IS NULL OR length(pipeline_id) BETWEEN 1 AND 100),
  CHECK (jsonb_typeof(stage_mappings) = 'object'),
  CHECK (jsonb_typeof(owner_mappings) = 'object')
);

ALTER TABLE sales_marketing_external_records
  DROP CONSTRAINT IF EXISTS sales_marketing_external_provider_fields_check;
ALTER TABLE sales_marketing_external_records
  ADD CONSTRAINT sales_marketing_external_provider_fields_check CHECK (
    provider_change_fields <@ ARRAY[
      'contact_name', 'contact_company', 'contact_title', 'contact_phone',
      'deal_title', 'deal_stage', 'deal_value', 'deal_close_date', 'deal_owner'
    ]::text[]
  );

ALTER TABLE sales_marketing_hubspot_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_hubspot_preferences FROM anon, authenticated;

COMMIT;
