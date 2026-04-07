BEGIN;

-- Add columns to track when a draft was actually sent via the provider,
-- plus the provider-assigned message and thread IDs from the send response.
ALTER TABLE email_drafts
  ADD COLUMN IF NOT EXISTS sent_at              timestamptz,
  ADD COLUMN IF NOT EXISTS provider_message_id  text,
  ADD COLUMN IF NOT EXISTS provider_thread_id   text;

-- Index for quick lookup by provider_draft_id + user_id (used by sendGmailDraft).
CREATE INDEX IF NOT EXISTS idx_email_drafts_provider_draft
  ON email_drafts (provider_draft_id, user_id)
  WHERE provider_draft_id IS NOT NULL;

COMMIT;
