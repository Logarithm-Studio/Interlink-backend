-- Persist a specific event/creator touch on every hosted-form attribution row.
BEGIN;

ALTER TABLE sales_marketing_contact_attributions
  ADD COLUMN IF NOT EXISTS activation_id uuid
    REFERENCES sales_marketing_activations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_attributions_activation_contact
  ON sales_marketing_contact_attributions(user_id, activation_id, captured_at DESC, contact_id)
  WHERE activation_id IS NOT NULL;

COMMIT;
