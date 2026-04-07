-- 012_event_type_rules.sql
-- Data-driven event type classification rules.
--
-- Each rule carries a JSONB `rule` payload with this structure:
--
--   {
--     "conditions": [
--       { "field": "title", "op": "contains", "value": "standup", "caseSensitive": false }
--     ],
--     "match": "any"   -- "any" | "all"
--   }
--
-- Supported fields : title | description | organizerEmail | provider
-- Supported ops    : contains | not_contains | equals | not_equals |
--                    starts_with | ends_with | matches_regex
--
-- Scope:
--   user_id = NULL => global rule (applies to all users)
--   provider = NULL => applies to all providers
--   Evaluation order: ORDER BY priority ASC (lower number = evaluated first)

BEGIN;

CREATE TABLE IF NOT EXISTS event_type_rules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        REFERENCES users(id) ON DELETE CASCADE,  -- NULL = global
  provider    TEXT,                                                  -- NULL = all providers
  priority    INT         NOT NULL DEFAULT 100,
  rule        JSONB       NOT NULL,
  event_type  TEXT        NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup for rule evaluation during sync
CREATE INDEX IF NOT EXISTS idx_event_type_rules_active
  ON event_type_rules (is_active, priority, user_id, provider);

-- ─── Seed default global rules ────────────────────────────────────────────
--
-- These replace the old hard-coded title heuristics in normalizer.ts.
-- They are global (user_id = NULL) and provider-agnostic (provider = NULL).
-- Operators use case-insensitive matching (caseSensitive omitted = false).
-- Users can deactivate, override, or add user-specific rules at any time.

INSERT INTO event_type_rules (priority, rule, event_type) VALUES

-- standup (priority 10)
(10,
 '{"match":"any","conditions":[
    {"field":"title","op":"contains","value":"standup"},
    {"field":"title","op":"contains","value":"stand-up"},
    {"field":"title","op":"contains","value":"stand up"}
 ]}'::jsonb,
 'standup'),

-- exam (priority 20)
(20,
 '{"match":"any","conditions":[
    {"field":"title","op":"contains","value":"exam"},
    {"field":"title","op":"contains","value":"test"},
    {"field":"title","op":"contains","value":"quiz"}
 ]}'::jsonb,
 'exam'),

-- class / lecture (priority 30)
(30,
 '{"match":"any","conditions":[
    {"field":"title","op":"contains","value":"class"},
    {"field":"title","op":"contains","value":"lecture"},
    {"field":"title","op":"contains","value":"seminar"}
 ]}'::jsonb,
 'class'),

-- personal training / workout (priority 40)
(40,
 '{"match":"any","conditions":[
    {"field":"title","op":"contains","value":"personal training"},
    {"field":"title","op":"contains","value":"workout"},
    {"field":"title","op":"starts_with","value":"pt "}
 ]}'::jsonb,
 'pt_meeting'),

-- 1:1 meeting (priority 50)
(50,
 '{"match":"any","conditions":[
    {"field":"title","op":"contains","value":"1:1"},
    {"field":"title","op":"contains","value":"one on one"},
    {"field":"title","op":"contains","value":"1-on-1"},
    {"field":"title","op":"contains","value":"1 on 1"}
 ]}'::jsonb,
 'one_on_one');

COMMIT;
