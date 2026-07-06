-- 054_google_accounts_multi.sql
-- Allow multiple Google accounts per user, each tagged with a role so the app
-- can bind Personal Mode to one account and Professional (Work) Mode to another.
--
-- Before: google_accounts.user_id was UNIQUE (one account per user).
-- After:  many rows per user; the account key is google_accounts.id.
--   - email      : the real connected Gmail address (was never stored before)
--   - role       : 'personal' | 'professional' | NULL — which mode uses this account
--   - is_primary : the fallback account when no role/mode is resolved

-- Drop the one-account-per-user constraint (default name from `user_id ... UNIQUE`).
ALTER TABLE google_accounts DROP CONSTRAINT IF EXISTS google_accounts_user_id_key;

ALTER TABLE google_accounts
  ADD COLUMN IF NOT EXISTS email      TEXT,
  ADD COLUMN IF NOT EXISTS role       TEXT,
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- role is constrained to the two app modes (or NULL = unassigned).
ALTER TABLE google_accounts DROP CONSTRAINT IF EXISTS google_accounts_role_check;
ALTER TABLE google_accounts
  ADD CONSTRAINT google_accounts_role_check
  CHECK (role IN ('personal', 'professional'));

-- Backfill: the existing single row per user becomes the primary Personal account.
-- (email is back-filled lazily on next token use / connect — it isn't stored today.)
UPDATE google_accounts
   SET is_primary = TRUE,
       role       = COALESCE(role, 'personal');

-- At most one account per (user, role) — one Personal, one Work.
CREATE UNIQUE INDEX IF NOT EXISTS uq_google_accounts_user_role
  ON google_accounts (user_id, role)
  WHERE role IS NOT NULL;

-- No duplicate connects of the same Gmail address for one user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_google_accounts_user_email
  ON google_accounts (user_id, lower(email))
  WHERE email IS NOT NULL;

-- At most one primary account per user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_google_accounts_user_primary
  ON google_accounts (user_id)
  WHERE is_primary = TRUE;
