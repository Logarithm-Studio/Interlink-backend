BEGIN;

-- Seed the conflict-resolution workflow that fires whenever a new scheduling
-- conflict is detected.  This is the default system workflow; users can create
-- additional workflows via future management APIs.
--
-- Trigger: calendar.conflict.detected with condition isNew = true
--
-- Flow:
--   1. notify_conflict  — push/email notification with 3 actions
--   2. reschedule path  — wait_for_input → calendar_reschedule → email_generate_preview → email_send
--   3. decline path     — wait_for_input → calendar_decline → email_generate_preview → email_send
--   4. dismiss path     — log and finish
--   5. email_generate_preview supports unlimited regeneration loops
--   6. email_send creates a Gmail draft and sends it

INSERT INTO workflows (id, name, trigger_type, definition, is_active)
VALUES (
  'a0000000-0000-4000-a000-000000000001',
  'Conflict Resolution',
  'calendar.conflict.detected',
  '{
    "trigger": {
      "conditions": [
        { "field": "conflict.isNew", "op": "equals", "value": true }
      ]
    },
    "steps": [
      {
        "id": "notify_conflict",
        "type": "notify",
        "config": {
          "title": "Scheduling Conflict Detected",
          "body": "You have overlapping events. Choose an action to resolve the conflict.",
          "actions": [
            { "label": "Reschedule an event", "actionKey": "reschedule", "nextStepId": "reschedule_input" },
            { "label": "Decline an event", "actionKey": "decline", "nextStepId": "decline_input" },
            { "label": "Dismiss", "actionKey": "dismiss", "nextStepId": "log_dismissed" }
          ],
          "timeoutSeconds": 86400,
          "timeoutNextStepId": "log_timeout"
        }
      },
      {
        "id": "reschedule_input",
        "type": "wait_for_input",
        "config": {
          "timeoutSeconds": 86400,
          "routes": {
            "submit_reschedule": "do_reschedule"
          },
          "timeoutNextStepId": "log_timeout"
        }
      },
      {
        "id": "do_reschedule",
        "type": "calendar_reschedule",
        "config": {
          "nextStepId": "email_generate_preview"
        }
      },
      {
        "id": "decline_input",
        "type": "wait_for_input",
        "config": {
          "timeoutSeconds": 86400,
          "routes": {
            "submit_decline": "do_decline"
          },
          "timeoutNextStepId": "log_timeout"
        }
      },
      {
        "id": "do_decline",
        "type": "calendar_decline",
        "config": {
          "nextStepId": "email_generate_preview"
        }
      },
      {
        "id": "email_generate_preview",
        "type": "email_generate_preview",
        "config": {
          "sendNextStepId": "send_email",
          "skipNextStepId": "log_complete",
          "timeoutSeconds": 86400,
          "timeoutNextStepId": "log_timeout"
        }
      },
      {
        "id": "send_email",
        "type": "email_send",
        "config": {
          "draftStepId": "email_generate_preview",
          "nextStepId": "log_complete"
        }
      },
      {
        "id": "log_complete",
        "type": "log",
        "config": { "message": "Conflict resolution workflow completed successfully" }
      },
      {
        "id": "log_dismissed",
        "type": "log",
        "config": { "message": "User dismissed the conflict notification" }
      },
      {
        "id": "log_timeout",
        "type": "log",
        "config": { "message": "Conflict workflow timed out waiting for user input", "level": "warn" }
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
