BEGIN;

-- Sales CRM depth: enrichment fields, deal activity timeline, reps/territories,
-- contracts, a "nurture" pipeline stage, and a per-user inbound web-form key.

ALTER TABLE sales_contacts
  ADD COLUMN IF NOT EXISTS territory         text,
  ADD COLUMN IF NOT EXISTS domain            text,
  ADD COLUMN IF NOT EXISTS industry          text,
  ADD COLUMN IF NOT EXISTS enriched          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz;

ALTER TABLE sales_deals
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz,
  ADD COLUMN IF NOT EXISTS owner_rep        text;

-- Extend the pipeline stage set with 'nurture' (re-engagement bucket).
ALTER TABLE sales_deals DROP CONSTRAINT IF EXISTS sales_deals_stage_check;
ALTER TABLE sales_deals ADD CONSTRAINT sales_deals_stage_check
  CHECK (stage IN ('lead','qualified','proposal','negotiation','won','lost','nurture'));

CREATE TABLE IF NOT EXISTS sales_activities (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id     uuid        REFERENCES sales_deals(id) ON DELETE CASCADE,
  contact_id  uuid        REFERENCES sales_contacts(id) ON DELETE SET NULL,
  kind        text        NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_activities_deal ON sales_activities (deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_activities_user ON sales_activities (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sales_reps (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  email      text,
  territory  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_reps_user ON sales_reps (user_id);

CREATE TABLE IF NOT EXISTS sales_contracts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id      uuid        REFERENCES sales_deals(id) ON DELETE CASCADE,
  title        text        NOT NULL,
  body         text,
  amount_cents bigint      NOT NULL DEFAULT 0,
  currency     text        NOT NULL DEFAULT 'USD',
  status       text        NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','sent','signed','declined')),
  sent_at      timestamptz,
  signed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_contracts_user ON sales_contracts (user_id, status);

-- Per-user public inbound web-form key (lead capture). `form_key` set by the app.
CREATE TABLE IF NOT EXISTS sales_settings (
  user_id    uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  form_key   text        UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
