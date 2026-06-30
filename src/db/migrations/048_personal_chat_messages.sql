-- Personal Mode AI assistant chat history (mirrors accountant_chat_messages).
CREATE TABLE personal_chat_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_personal_chat_user ON personal_chat_messages(user_id, created_at DESC);
