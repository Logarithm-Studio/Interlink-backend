-- Assign marketing leads to a rep in the account's existing sales roster.
BEGIN;

ALTER TABLE sales_contacts
  ADD COLUMN IF NOT EXISTS marketing_owner_rep_id uuid REFERENCES sales_reps(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_contacts_marketing_owner
  ON sales_contacts(marketing_owner_rep_id)
  WHERE marketing_owner_rep_id IS NOT NULL;

COMMIT;
