-- Bulk campaign audiences require an explicit user-recorded marketing permission flag.
-- Existing contacts remain excluded until their permission is confirmed.
BEGIN;

ALTER TABLE sales_contacts
  ADD COLUMN IF NOT EXISTS marketing_opt_in boolean NOT NULL DEFAULT false;

COMMIT;
