-- Marketing campaigns are Interlink-owned records; provider audience membership and
-- suppression remain owned by the delivery provider.
BEGIN;

ALTER TABLE sales_marketing_campaigns
  DROP CONSTRAINT IF EXISTS sales_marketing_campaigns_status_check;

ALTER TABLE sales_marketing_campaigns
  ADD CONSTRAINT sales_marketing_campaigns_status_check
    CHECK (status IN ('draft', 'provider_creating', 'provider_draft', 'provider_review', 'scheduling', 'scheduled', 'unscheduling', 'sending', 'sent', 'failed', 'send_review')),
  ADD COLUMN IF NOT EXISTS provider_campaign_id text,
  ADD COLUMN IF NOT EXISTS provider_audience_id text,
  ADD COLUMN IF NOT EXISTS from_name text,
  ADD COLUMN IF NOT EXISTS reply_to text,
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS objective text,
  ADD COLUMN IF NOT EXISTS offer text,
  ADD COLUMN IF NOT EXISTS success_metric text,
  ADD COLUMN IF NOT EXISTS channels text[] NOT NULL DEFAULT ARRAY['email']::text[],
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS end_date date,
  ADD COLUMN IF NOT EXISTS budget_cents bigint;

ALTER TABLE sales_marketing_campaigns
  ADD CONSTRAINT sales_marketing_campaign_budget_check CHECK (budget_cents IS NULL OR budget_cents >= 0),
  ADD CONSTRAINT sales_marketing_campaign_dates_check CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  ADD CONSTRAINT sales_marketing_campaign_channels_check CHECK (
    channels <@ ARRAY['email','instagram','facebook','linkedin','youtube','blog','landing_page','search','ad','influencer','event','other']::text[]
  );

ALTER TABLE sales_contacts
  ADD COLUMN IF NOT EXISTS marketing_campaign_id uuid REFERENCES sales_marketing_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS marketing_attribution jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_sales_contacts_marketing_campaign
  ON sales_contacts(user_id, marketing_campaign_id, created_at DESC)
  WHERE marketing_campaign_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_campaign_provider_id
  ON sales_marketing_campaigns(user_id, provider_campaign_id)
  WHERE provider_campaign_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_marketing_content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES sales_marketing_campaigns(id) ON DELETE SET NULL,
  title text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'instagram', 'facebook', 'linkedin', 'youtube', 'blog', 'landing_page', 'search', 'ad', 'influencer', 'event', 'other')),
  body text NOT NULL DEFAULT '',
  asset_url text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'planned', 'published', 'completed', 'cancelled')),
  scheduled_at timestamptz,
  published_at timestamptz,
  provider text,
  provider_item_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_content_calendar
  ON sales_marketing_content_items(user_id, scheduled_at, status);

CREATE INDEX IF NOT EXISTS idx_marketing_content_campaign
  ON sales_marketing_content_items(user_id, campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sales_marketing_approval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('campaign', 'content')),
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('submitted', 'approved', 'rejected', 'scheduled', 'published', 'completed', 'sent', 'cancelled')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_approval_entity
  ON sales_marketing_approval_events(user_id, entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sales_marketing_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES sales_contacts(id) ON DELETE CASCADE,
  opted_in boolean NOT NULL,
  source text NOT NULL DEFAULT 'user_recorded',
  evidence text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_consent_contact
  ON sales_marketing_consent_events(user_id, contact_id, created_at DESC);

-- These records are read and written through the authenticated Express API only.
-- Revoke direct Data API access and keep RLS enabled as defense in depth.
ALTER TABLE sales_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_marketing_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_marketing_content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_marketing_approval_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_marketing_consent_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_contacts, sales_marketing_campaigns, sales_marketing_content_items,
  sales_marketing_approval_events, sales_marketing_consent_events FROM anon, authenticated;

COMMIT;
