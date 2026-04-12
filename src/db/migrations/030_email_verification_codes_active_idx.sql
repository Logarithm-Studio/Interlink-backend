-- 030_email_verification_codes_active_idx.sql
-- Speeds up active-code invalidation and verification lookups.

CREATE INDEX IF NOT EXISTS idx_email_verification_codes_active_email_purpose_created
  ON email_verification_codes (email, purpose, created_at DESC)
  WHERE used_at IS NULL;
