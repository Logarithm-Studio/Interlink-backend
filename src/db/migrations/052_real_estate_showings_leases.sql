BEGIN;

-- Real Estate depth: showings (open-house / viewings) + leases (renewal tracking).

CREATE TABLE IF NOT EXISTS re_showings (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address      text        NOT NULL,
  lead_name    text,
  scheduled_at timestamptz,
  notes        text,
  source       text        NOT NULL DEFAULT 'manual',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_re_showings_user ON re_showings (user_id, scheduled_at);

CREATE TABLE IF NOT EXISTS re_leases (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property     text        NOT NULL,
  tenant_name  text,
  tenant_email text,
  end_date     date,
  rent_cents   bigint,
  source       text        NOT NULL DEFAULT 'manual',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_re_leases_user ON re_leases (user_id, end_date);

COMMIT;
