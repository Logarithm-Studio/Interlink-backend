-- 031_users_profile_fields.sql
-- Store user profile fields (full_name, contact_no, company_name, address)
-- alongside core identity so settings profile CRUD reads/writes a single source
-- of truth instead of relying exclusively on Supabase user_metadata.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS full_name    TEXT,
  ADD COLUMN IF NOT EXISTS contact_no   TEXT,
  ADD COLUMN IF NOT EXISTS company_name TEXT,
  ADD COLUMN IF NOT EXISTS address      TEXT,
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMIT;
