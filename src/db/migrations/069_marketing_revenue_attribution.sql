-- Connect attributed marketing leads to the existing sales pipeline.
-- Existing name-only deals are intentionally not auto-linked: that would guess
-- contact identity or campaign attribution from ambiguous display names.
BEGIN;

ALTER TABLE sales_deals
  ADD COLUMN contact_id uuid REFERENCES sales_contacts(id) ON DELETE SET NULL,
  ADD COLUMN marketing_campaign_id uuid REFERENCES sales_marketing_campaigns(id) ON DELETE SET NULL;

-- Keep campaign funnel queries and foreign-key deletes indexed.
CREATE INDEX idx_sales_deals_contact_fk
  ON sales_deals(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_sales_deals_marketing_campaign_fk
  ON sales_deals(marketing_campaign_id) WHERE marketing_campaign_id IS NOT NULL;
CREATE INDEX idx_sales_deals_user_marketing_campaign_stage
  ON sales_deals(user_id, marketing_campaign_id, stage) WHERE marketing_campaign_id IS NOT NULL;

-- CRM data is served by the authenticated Express API using the server role.
-- Prevent direct PostgREST access to deals, activities, and contract records.
ALTER TABLE sales_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_contracts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_deals, sales_activities, sales_contracts FROM anon, authenticated;

COMMIT;
