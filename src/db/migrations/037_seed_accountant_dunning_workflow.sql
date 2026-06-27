BEGIN;

-- Seed the "Accountant — Dunning" workflow (Professional Mode).
--
-- Trigger: schedule.weekly. Represents the PRD §4.4 "weekly aged-receivables
-- scan". In iteration 1 the scan endpoint (POST /api/v1/accountant/scan) marks
-- invoices overdue and notifies the user directly; the actual reminder send is
-- user-approved via the interactive flow (human approval for money-adjacent
-- actions, PRD §5). This row makes the workflow visible in the engine and is the
-- attach point for richer automated sequences in later iterations.

INSERT INTO workflows (id, name, trigger_type, definition, is_active)
VALUES (
  'a0000000-0000-4000-a000-000000000002',
  'Accountant — Dunning',
  'schedule.weekly',
  '{
    "trigger": { "conditions": [] },
    "steps": [
      {
        "id": "scan_overdue",
        "type": "log",
        "config": {
          "message": "Weekly dunning scan: overdue invoices flagged; user notified to review and approve reminders."
        }
      }
    ]
  }'::jsonb,
  true
)
ON CONFLICT (id) DO UPDATE SET
  definition = EXCLUDED.definition,
  name       = EXCLUDED.name,
  is_active  = EXCLUDED.is_active;

COMMIT;
