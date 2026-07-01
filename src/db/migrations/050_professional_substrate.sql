BEGIN;

-- Shared "Professional Work OS" substrate: per-vertical data tables + a persona
-- tag on the agent activity feed so every profession can share the same feed,
-- confirm-before-execute flow, and dashboard scaffold.

-- 1. Tag the existing activity feed with the persona that produced each row.
ALTER TABLE accountant_activity
  ADD COLUMN IF NOT EXISTS persona text NOT NULL DEFAULT 'finance';

CREATE INDEX IF NOT EXISTS idx_accountant_activity_user_persona_created
  ON accountant_activity (user_id, persona, created_at DESC);

-- 2. Sales (+ merged Marketing) ------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_contacts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  email       text,
  company     text,
  title       text,
  phone       text,
  notes       text,
  source      text        NOT NULL DEFAULT 'manual',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_contacts_user ON sales_contacts (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sales_deals (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text        NOT NULL,
  contact_name  text,
  company       text,
  amount_cents  bigint      NOT NULL DEFAULT 0,
  currency      text        NOT NULL DEFAULT 'USD',
  stage         text        NOT NULL DEFAULT 'lead'
                  CHECK (stage IN ('lead','qualified','proposal','negotiation','won','lost')),
  close_date    date,
  notes         text,
  source        text        NOT NULL DEFAULT 'manual',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_deals_user ON sales_deals (user_id, stage);

-- 3. Customer Support ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_tickets (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject        text        NOT NULL,
  body           text,
  customer_name  text,
  customer_email text,
  priority       text        NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low','medium','high','urgent')),
  status         text        NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','pending','escalated','resolved')),
  category       text,
  sla_due_at     timestamptz,
  source         text        NOT NULL DEFAULT 'manual',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets (user_id, status);

-- 4. Real Estate ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS re_listings (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address      text        NOT NULL,
  price_cents  bigint      NOT NULL DEFAULT 0,
  currency     text        NOT NULL DEFAULT 'USD',
  beds         integer,
  baths        numeric,
  sqft         integer,
  status       text        NOT NULL DEFAULT 'active'
                 CHECK (status IN ('draft','active','pending','sold')),
  description  text,
  notes        text,
  source       text        NOT NULL DEFAULT 'manual',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_re_listings_user ON re_listings (user_id, status);

CREATE TABLE IF NOT EXISTS re_leads (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  email        text,
  phone        text,
  budget_cents bigint,
  interest     text,
  stage        text        NOT NULL DEFAULT 'new'
                 CHECK (stage IN ('new','qualified','touring','offer','closed','lost')),
  notes        text,
  source       text        NOT NULL DEFAULT 'manual',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_re_leads_user ON re_leads (user_id, stage);

-- 5. HR (+ merged Recruiter) ---------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_candidates (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  email        text,
  role         text,
  stage        text        NOT NULL DEFAULT 'applied'
                 CHECK (stage IN ('applied','screening','interview','offer','hired','rejected')),
  score        integer,
  resume_text  text,
  notes        text,
  source       text        NOT NULL DEFAULT 'manual',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hr_candidates_user ON hr_candidates (user_id, stage);

CREATE TABLE IF NOT EXISTS hr_openings (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text        NOT NULL,
  department  text,
  location    text,
  status      text        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','on_hold','closed')),
  notes       text,
  source      text        NOT NULL DEFAULT 'manual',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hr_openings_user ON hr_openings (user_id, status);

COMMIT;
