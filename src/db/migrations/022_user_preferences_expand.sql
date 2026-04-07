-- 022_user_preferences_expand.sql
-- Add tone_preference, notify_via, and timezone columns to user_preferences.
-- These columns support the AI email generation (tone), notification routing
-- (push vs email vs both), and timezone-aware scheduling features.

BEGIN;

-- Tone preference for AI-generated emails: professional, friendly, concise, formal.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS tone_preference text NOT NULL DEFAULT 'professional';

-- How the user wants to receive notifications: push, email, or both.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS notify_via text NOT NULL DEFAULT 'both';

-- User timezone override (e.g. "America/New_York"). Falls back to
-- users.timezone when null.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS timezone text;

-- Add check constraints.
ALTER TABLE user_preferences
  ADD CONSTRAINT chk_tone_preference
    CHECK (tone_preference IN ('professional', 'friendly', 'concise', 'formal'));

ALTER TABLE user_preferences
  ADD CONSTRAINT chk_notify_via
    CHECK (notify_via IN ('push', 'email', 'both'));

COMMIT;
