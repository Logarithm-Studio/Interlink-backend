-- Store only keyed IP fingerprints for a shared, short-lived public form throttle.
BEGIN;

CREATE TABLE IF NOT EXISTS sales_marketing_form_rate_limits (
  ip_fingerprint text PRIMARY KEY CHECK (ip_fingerprint ~ '^[0-9a-f]{64}$'),
  bucket_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 13),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_form_rate_limits_updated
  ON sales_marketing_form_rate_limits(updated_at);

ALTER TABLE sales_marketing_form_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sales_marketing_form_rate_limits FROM anon, authenticated;

COMMIT;
