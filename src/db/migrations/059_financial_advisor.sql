BEGIN;

-- Financial Advisor depth (Professional Mode). The "finance" persona is now branded
-- "Financial Advisor" and gains advisory capabilities on top of the AR/expense engine:
-- a client book with portfolio holdings, and a compliance-action tracker.

CREATE TABLE IF NOT EXISTS advisor_clients (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  email        text,
  risk_profile text        NOT NULL DEFAULT 'balanced'
                 CHECK (risk_profile IN ('conservative','balanced','growth','aggressive')),
  notes        text,
  source       text        NOT NULL DEFAULT 'manual',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_advisor_clients_user ON advisor_clients (user_id);

-- One row per position held in a client's portfolio. target_pct is the client's
-- intended allocation for that position's asset class (used for drift analysis).
CREATE TABLE IF NOT EXISTS advisor_holdings (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   uuid        NOT NULL REFERENCES advisor_clients(id) ON DELETE CASCADE,
  symbol      text        NOT NULL,
  asset_class text        NOT NULL DEFAULT 'equity'
                CHECK (asset_class IN ('equity','bond','cash','alt')),
  value_cents bigint      NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_advisor_holdings_client ON advisor_holdings (client_id);
CREATE INDEX IF NOT EXISTS idx_advisor_holdings_user ON advisor_holdings (user_id);

-- Compliance actions the advisor must track (KYC refresh, suitability review, etc.).
CREATE TABLE IF NOT EXISTS advisor_compliance_items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   uuid        REFERENCES advisor_clients(id) ON DELETE CASCADE,
  type        text        NOT NULL
                CHECK (type IN ('kyc_refresh','suitability_review','adv_disclosure','rmd','beneficiary')),
  title       text        NOT NULL,
  due_date    date,
  status      text        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','in_progress','done')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_advisor_compliance_user ON advisor_compliance_items (user_id, status);

COMMIT;
