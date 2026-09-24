-- Durable, auditable pointers for marketer-confirmed CRM writes.
-- Provider payloads and credentials are deliberately not stored here.
CREATE TABLE IF NOT EXISTS sales_marketing_external_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('hubspot')),
  record_type text NOT NULL CHECK (record_type IN ('contact', 'deal')),
  local_record_id uuid NOT NULL,
  external_record_id text,
  sync_status text NOT NULL DEFAULT 'pending'
    CHECK (sync_status IN ('pending', 'syncing', 'synced', 'review', 'failed')),
  sync_started_at timestamptz,
  last_synced_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, record_type, local_record_id),
  CHECK (sync_status <> 'synced' OR external_record_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_external_records_provider_id
  ON sales_marketing_external_records(user_id, provider, record_type, external_record_id)
  WHERE external_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_external_records_local
  ON sales_marketing_external_records(user_id, record_type, local_record_id);

CREATE TABLE IF NOT EXISTS sales_marketing_external_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('hubspot')),
  record_type text NOT NULL CHECK (record_type IN ('contact', 'deal')),
  local_record_id uuid NOT NULL,
  external_record_id text,
  operation text NOT NULL CHECK (operation IN ('create', 'update', 'associate', 'reconcile')),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'review')),
  detail text NOT NULL CHECK (length(detail) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_external_sync_events_history
  ON sales_marketing_external_sync_events(user_id, local_record_id, created_at DESC);

ALTER TABLE sales_marketing_external_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_marketing_external_sync_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_external_records, sales_marketing_external_sync_events FROM anon, authenticated;
