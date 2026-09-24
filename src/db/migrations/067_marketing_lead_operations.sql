-- Close the inbound lead loop with deduplicated attribution and human-owned follow-up tasks.
BEGIN;

ALTER TABLE sales_marketing_campaigns
  ADD COLUMN provider_action_started_at timestamptz;

ALTER TABLE sales_contacts
  ADD COLUMN marketing_lead_status text NOT NULL DEFAULT 'new'
    CHECK (marketing_lead_status IN ('new','qualified','following_up','nurture','converted','disqualified'));

CREATE TABLE IF NOT EXISTS sales_marketing_contact_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES sales_contacts(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES sales_marketing_campaigns(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'public_form',
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_attribution_campaign
  ON sales_marketing_contact_attributions(user_id, campaign_id, captured_at DESC)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_attribution_contact
  ON sales_marketing_contact_attributions(user_id, contact_id, captured_at DESC);

INSERT INTO sales_marketing_contact_attributions (user_id,contact_id,campaign_id,source,attribution,captured_at)
SELECT user_id,id,marketing_campaign_id,source,COALESCE(marketing_attribution,'{}'::jsonb),created_at
  FROM sales_contacts WHERE marketing_campaign_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_marketing_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES sales_contacts(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES sales_marketing_campaigns(id) ON DELETE SET NULL,
  title text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  notes text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_followups_queue
  ON sales_marketing_followups(user_id, status, due_at ASC);
CREATE INDEX IF NOT EXISTS idx_marketing_followups_contact
  ON sales_marketing_followups(user_id, contact_id, created_at DESC);

ALTER TABLE sales_marketing_contact_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_marketing_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_contact_attributions, sales_marketing_followups FROM anon, authenticated;

COMMIT;
