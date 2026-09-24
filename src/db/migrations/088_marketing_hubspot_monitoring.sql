-- Opt-in read-only change monitoring for explicitly mapped HubSpot marketing deals.
-- Store property hashes and field names only; provider values remain behind the Express API.
BEGIN;

ALTER TABLE sales_marketing_external_records
  ADD COLUMN IF NOT EXISTS monitor_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provider_monitor_dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_fingerprints jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_fingerprint_key_id text,
  ADD COLUMN IF NOT EXISTS provider_change_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS provider_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_check_error text CHECK (provider_check_error IS NULL OR length(provider_check_error) <= 1000),
  ADD CONSTRAINT sales_marketing_external_provider_fields_check CHECK (
    provider_change_fields <@ ARRAY[
      'contact_name', 'contact_company', 'contact_title', 'contact_phone',
      'deal_title', 'deal_stage', 'deal_value', 'deal_close_date'
    ]::text[]
  );

CREATE INDEX IF NOT EXISTS idx_marketing_external_records_monitor_due
  ON sales_marketing_external_records (provider_monitor_dispatched_at ASC NULLS FIRST, user_id, provider_last_checked_at)
  WHERE provider = 'hubspot' AND record_type = 'deal' AND monitor_enabled = true AND external_record_id IS NOT NULL;

COMMIT;
