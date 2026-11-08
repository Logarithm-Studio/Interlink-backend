-- Keep role, clock and file fingerprint even before a task has its first write proposal.
ALTER TABLE autolink_tasks ADD COLUMN execution_context jsonb NOT NULL DEFAULT '{}'::jsonb;
