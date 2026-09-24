-- Track the operational work and spend behind events and creator partnerships.
BEGIN;

CREATE TABLE IF NOT EXISTS sales_marketing_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES sales_marketing_campaigns(id) ON DELETE SET NULL,
  activation_type text NOT NULL CHECK (activation_type IN ('event', 'influencer')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  owner text,
  deliverables text NOT NULL DEFAULT '',
  activation_date date,
  planned_cost numeric(13,2) CHECK (planned_cost IS NULL OR planned_cost >= 0),
  actual_cost numeric(13,2) CHECK (actual_cost IS NULL OR actual_cost >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  external_url text,
  outcome text NOT NULL DEFAULT '',
  reach_count integer CHECK (reach_count IS NULL OR reach_count >= 0),
  engagement_count integer CHECK (engagement_count IS NULL OR engagement_count >= 0),
  lead_count integer CHECK (lead_count IS NULL OR lead_count >= 0),
  conversion_count integer CHECK (conversion_count IS NULL OR conversion_count >= 0),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_activations_user_date
  ON sales_marketing_activations(user_id, activation_date, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_activations_campaign
  ON sales_marketing_activations(user_id, campaign_id, activation_date)
  WHERE campaign_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_marketing_activation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activation_id uuid NOT NULL REFERENCES sales_marketing_activations(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('created', 'updated', 'status_changed')),
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_activation_events_activation
  ON sales_marketing_activation_events(user_id, activation_id, created_at DESC);

ALTER TABLE sales_marketing_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_marketing_activation_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_activations, sales_marketing_activation_events FROM anon, authenticated;

COMMIT;
