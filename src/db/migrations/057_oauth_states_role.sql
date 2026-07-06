-- 057_oauth_states_role.sql
-- Carry the intended Google account role (personal | professional) through the
-- OAuth connect round-trip, so the callback can bind the newly connected
-- mailbox to the mode the user chose when starting the connect.

ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS role TEXT;
