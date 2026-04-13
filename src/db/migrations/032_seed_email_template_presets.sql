-- 032_seed_email_template_presets.sql
-- Ensures each existing user has the built-in Brief / Formal / Casual decline
-- templates available. New users are seeded by application code
-- (ensurePresetTemplates) — this migration back-fills the current userbase so
-- the Mail Templates screen is never empty.

BEGIN;

-- Brief
INSERT INTO email_templates (user_id, name, subject_template, body_template, is_active_default)
SELECT u.id,
       'Brief',
       'Cannot make it: {{eventTitle}}',
       'Hi,' || chr(10) || chr(10) ||
       'Unfortunately I will not be able to attend {{eventTitle}}. Apologies for the short notice.' || chr(10) || chr(10) ||
       'Thanks.',
       FALSE
  FROM users u
 WHERE NOT EXISTS (
         SELECT 1 FROM email_templates t
          WHERE t.user_id = u.id AND t.name = 'Brief'
       );

-- Formal
INSERT INTO email_templates (user_id, name, subject_template, body_template, is_active_default)
SELECT u.id,
       'Formal',
       'Regrets: Unable to attend {{eventTitle}}',
       'Dear team,' || chr(10) || chr(10) ||
       'I regret to inform you that I will be unable to attend "{{eventTitle}}" on {{eventStart}}. ' ||
       'I apologise for any inconvenience this may cause and would appreciate receiving any notes or ' ||
       'action items afterwards so I can follow up accordingly.' || chr(10) || chr(10) ||
       'Kind regards.',
       FALSE
  FROM users u
 WHERE NOT EXISTS (
         SELECT 1 FROM email_templates t
          WHERE t.user_id = u.id AND t.name = 'Formal'
       );

-- Casual
INSERT INTO email_templates (user_id, name, subject_template, body_template, is_active_default)
SELECT u.id,
       'Casual',
       'Skipping {{eventTitle}} — sorry!',
       'Hey!' || chr(10) || chr(10) ||
       'Something came up and I won''t be able to make {{eventTitle}}. ' ||
       'Happy to catch up on anything I missed — just send the notes my way.' || chr(10) || chr(10) ||
       'Cheers.',
       FALSE
  FROM users u
 WHERE NOT EXISTS (
         SELECT 1 FROM email_templates t
          WHERE t.user_id = u.id AND t.name = 'Casual'
       );

COMMIT;
