BEGIN;

-- Group the flat personal-assistant message log into conversations so the app can
-- show a chat-history list (like the professional assistant already has, migration 049).

CREATE TABLE IF NOT EXISTS personal_conversations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text        NOT NULL DEFAULT 'New chat',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_personal_conversations_user_updated
  ON personal_conversations (user_id, updated_at DESC);

ALTER TABLE personal_chat_messages
  ADD COLUMN IF NOT EXISTS conversation_id uuid
    REFERENCES personal_conversations(id) ON DELETE CASCADE;

-- Backfill: collapse each user's existing flat history into one conversation so
-- nothing is orphaned once conversation_id becomes the grouping key.
DO $$
DECLARE
  u uuid;
  conv uuid;
BEGIN
  FOR u IN
    SELECT DISTINCT user_id FROM personal_chat_messages WHERE conversation_id IS NULL
  LOOP
    INSERT INTO personal_conversations (user_id, title, created_at, updated_at)
    VALUES (
      u,
      'Previous chat',
      COALESCE((SELECT min(created_at) FROM personal_chat_messages WHERE user_id = u), now()),
      COALESCE((SELECT max(created_at) FROM personal_chat_messages WHERE user_id = u), now())
    )
    RETURNING id INTO conv;

    UPDATE personal_chat_messages
       SET conversation_id = conv
     WHERE user_id = u AND conversation_id IS NULL;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_personal_chat_conversation
  ON personal_chat_messages (conversation_id, created_at);

COMMIT;
