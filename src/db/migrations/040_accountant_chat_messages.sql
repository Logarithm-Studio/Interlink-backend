BEGIN;

-- Lightweight memory for the "Ask your AI accountant" assistant (Professional Mode).

CREATE TABLE IF NOT EXISTS accountant_chat_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accountant_chat_user_created
  ON accountant_chat_messages (user_id, created_at);

COMMIT;
