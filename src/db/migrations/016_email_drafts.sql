BEGIN;

-- Tracks every email draft created on behalf of a user.
-- A row is inserted once per idempotency_key; subsequent calls with the same
-- key return the existing row (ON CONFLICT DO NOTHING in the service).
CREATE TABLE IF NOT EXISTS email_drafts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id     uuid        REFERENCES workflow_executions(id),
  step_id          text        NOT NULL,
  user_id          uuid        NOT NULL REFERENCES users(id),
  -- "gmail" only for now; "outlook" added in a later step once Step 16 is
  -- extended to Microsoft Graph Mail.
  provider         text        NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  -- Provider-assigned draft identifier (e.g. Gmail messageId).
  provider_draft_id text,
  -- Recipient email address the draft was created for.
  recipient        text        NOT NULL,
  subject          text        NOT NULL,
  -- Deterministic key: email:draft:<executionId>:<stepId>:<recipientHash>:<subjectHash>
  idempotency_key  text        NOT NULL,
  is_sent          boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_drafts_idem
  ON email_drafts (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_email_drafts_execution
  ON email_drafts (execution_id)
  WHERE execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_drafts_user
  ON email_drafts (user_id);

COMMIT;
