-- Durable approval and delivery records. External writes are claimed before execution.
CREATE TABLE sales_marketing_email_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES sales_contacts(id) ON DELETE CASCADE,
  google_account_id uuid NOT NULL,
  sender_email text NOT NULL,
  recipient_email text NOT NULL,
  initial_message_id text NOT NULL,
  thread_id text NOT NULL,
  reply_header text,
  initial_sent_at timestamptz NOT NULL,
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps)='array'),
  next_step integer NOT NULL DEFAULT 0 CHECK (next_step>=0),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','checking','sending','completed','replied','cancelled','review')),
  sent_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,initial_message_id)
);
CREATE INDEX marketing_email_sequences_due ON sales_marketing_email_sequences(due_at) WHERE status='pending';
CREATE INDEX marketing_email_sequences_user ON sales_marketing_email_sequences(user_id,created_at DESC);

CREATE TABLE sales_marketing_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL UNIQUE REFERENCES sales_contracts(id) ON DELETE CASCADE,
  signer_name text NOT NULL,
  signer_email text NOT NULL,
  requirements text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','preparing','prepared','sending','sent','completed','declined','voided','review')),
  account_id text,
  base_uri text,
  envelope_id text,
  provider_version text,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marketing_agreements_user ON sales_marketing_agreements(user_id,created_at DESC);
CREATE INDEX marketing_agreements_poll ON sales_marketing_agreements(updated_at) WHERE status IN ('sent','sending','review') AND envelope_id IS NOT NULL;

CREATE TABLE sales_marketing_research_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  objective text NOT NULL,
  contact_ids uuid[] NOT NULL CHECK (cardinality(contact_ids) BETWEEN 1 AND 25),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marketing_research_plans_user ON sales_marketing_research_plans(user_id,created_at DESC);

CREATE TABLE sales_marketing_research_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES sales_marketing_research_plans(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('notion','todoist')),
  destination_id text NOT NULL,
  item_key text NOT NULL,
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','synced','review')),
  external_id text,
  external_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id,provider,destination_id,item_key)
);
CREATE INDEX marketing_research_exports_user ON sales_marketing_research_exports(user_id,plan_id);

ALTER TABLE sales_marketing_email_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_marketing_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_marketing_research_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_marketing_research_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sales_marketing_email_sequences,sales_marketing_agreements,sales_marketing_research_plans,sales_marketing_research_exports FROM anon,authenticated;
