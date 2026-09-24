-- Count first-party redirects to activation registration/brief destinations without visitor identifiers.
BEGIN;

ALTER TABLE sales_marketing_activations
  ADD COLUMN IF NOT EXISTS public_link_token text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_activations_public_link_token
  ON sales_marketing_activations (public_link_token)
  WHERE public_link_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_marketing_activation_link_metrics (
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activation_id   uuid        NOT NULL REFERENCES sales_marketing_activations(id) ON DELETE CASCADE,
  metric_date     date        NOT NULL,
  redirect_count bigint      NOT NULL DEFAULT 0 CHECK (redirect_count >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, activation_id, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_marketing_activation_link_metrics_user_date
  ON sales_marketing_activation_link_metrics (user_id, metric_date DESC, activation_id);

ALTER TABLE sales_marketing_activation_link_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_activation_link_metrics FROM anon, authenticated;

COMMIT;
