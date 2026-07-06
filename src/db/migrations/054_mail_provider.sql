-- Per-user mailbox provider preference for the Mails tab + assistant mail tools.
-- 'gmail' (default) reads/sends via Google; 'outlook' via Microsoft Graph.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mail_provider text NOT NULL DEFAULT 'gmail'
  CHECK (mail_provider IN ('gmail', 'outlook'));
