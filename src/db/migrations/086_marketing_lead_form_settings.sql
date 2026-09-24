-- Per-account branding and permission copy for the hosted lead form.
BEGIN;

ALTER TABLE sales_settings
  ADD COLUMN IF NOT EXISTS form_brand_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS form_headline text NOT NULL DEFAULT 'Get in touch',
  ADD COLUMN IF NOT EXISTS form_description text NOT NULL DEFAULT 'Leave your details and our team will follow up.',
  ADD COLUMN IF NOT EXISTS form_accent_color text NOT NULL DEFAULT '#4545d6',
  ADD COLUMN IF NOT EXISTS form_privacy_policy_url text,
  ADD COLUMN IF NOT EXISTS form_marketing_consent text;

COMMIT;
