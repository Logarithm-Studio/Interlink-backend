-- Stores the user's selected persona for each mode independently.
-- mode='personal'  → their life profession (developer, student, etc.)
-- mode='professional' → their work role (finance, product_manager, hr, etc.)
CREATE TABLE profession_profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('personal', 'professional')),
  persona     TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, mode)
);

CREATE INDEX idx_profession_profiles_user ON profession_profiles(user_id);
