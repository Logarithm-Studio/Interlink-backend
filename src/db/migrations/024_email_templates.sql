BEGIN;

CREATE TABLE IF NOT EXISTS email_templates (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text        NOT NULL,
  subject_template  text        NOT NULL,
  body_template     text        NOT NULL,
  is_active_default boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_templates_user
  ON email_templates (user_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_templates_user_active_default
  ON email_templates (user_id)
  WHERE is_active_default = true;

COMMIT;
