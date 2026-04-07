import { query } from "../config/db";

// ─── Rule shape (mirrors the `rule` JSONB column) ──────────────────────────

export type RuleField = "title" | "description" | "organizerEmail" | "provider";

export type RuleOp =
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "starts_with"
  | "ends_with"
  | "matches_regex";

export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string;
  /** Defaults to false — comparisons are case-insensitive unless explicitly true */
  caseSensitive?: boolean;
}

export interface RuleDefinition {
  conditions: RuleCondition[];
  /** "any" = at least one condition matches; "all" = every condition must match */
  match?: "any" | "all";
}

export interface EventTypeRule {
  id: string;
  userId: string | null;
  provider: string | null;
  priority: number;
  rule: RuleDefinition;
  eventType: string;
  isActive: boolean;
}

// ─── Canonical event fields evaluated during classification ────────────────

export interface ClassifiableEvent {
  title: string;
  description: string | null;
  organizerEmail: string | null;
  provider: string;
}

// ─── DB loader ────────────────────────────────────────────────────────────

/**
 * Load all active rules that apply to a given user + provider combination.
 *
 * Rules are scoped by:
 *   - user_id = NULL  → global (applies to every user)
 *   - user_id = userId → user-specific override
 *   - provider = NULL  → all providers
 *   - provider = <name> → specific provider
 *
 * Ordered by `priority ASC` so lower numbers are evaluated first.
 * Call this ONCE per sync batch and pass the result to `classifyEvent`.
 */
export async function loadActiveRules(
  userId: string,
  provider: string,
): Promise<EventTypeRule[]> {
  const result = await query<{
    id: string;
    user_id: string | null;
    provider: string | null;
    priority: number;
    rule: RuleDefinition;
    event_type: string;
    is_active: boolean;
  }>(
    `SELECT id, user_id, provider, priority, rule, event_type, is_active
     FROM event_type_rules
     WHERE is_active = TRUE
       AND (user_id IS NULL OR user_id = $1)
       AND (provider IS NULL OR provider = $2)
     ORDER BY priority ASC`,
    [userId, provider],
  );

  return result.rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    provider: r.provider,
    priority: r.priority,
    rule: r.rule,
    eventType: r.event_type,
    isActive: r.is_active,
  }));
}

// ─── Condition evaluator (pure) ────────────────────────────────────────────

function getFieldValue(
  event: ClassifiableEvent,
  field: RuleField,
): string | null {
  switch (field) {
    case "title":
      return event.title;
    case "description":
      return event.description;
    case "organizerEmail":
      return event.organizerEmail;
    case "provider":
      return event.provider;
  }
}

function evaluateCondition(
  event: ClassifiableEvent,
  condition: RuleCondition,
): boolean {
  const raw = getFieldValue(event, condition.field);
  if (raw === null || raw === undefined) {
    // A missing field can only satisfy not_contains / not_equals
    return condition.op === "not_contains" || condition.op === "not_equals";
  }

  const haystack = condition.caseSensitive ? raw : raw.toLowerCase();
  const needle = condition.caseSensitive
    ? condition.value
    : condition.value.toLowerCase();

  switch (condition.op) {
    case "contains":
      return haystack.includes(needle);
    case "not_contains":
      return !haystack.includes(needle);
    case "equals":
      return haystack === needle;
    case "not_equals":
      return haystack !== needle;
    case "starts_with":
      return haystack.startsWith(needle);
    case "ends_with":
      return haystack.endsWith(needle);
    case "matches_regex": {
      try {
        const flags = condition.caseSensitive ? "" : "i";
        return new RegExp(condition.value, flags).test(raw);
      } catch {
        // Invalid regex in DB rule — treat as non-match, never throw
        return false;
      }
    }
  }
}

function evaluateRule(event: ClassifiableEvent, rule: RuleDefinition): boolean {
  const { conditions, match = "any" } = rule;
  if (!conditions || conditions.length === 0) return false;

  if (match === "all") {
    return conditions.every((c) => evaluateCondition(event, c));
  }
  return conditions.some((c) => evaluateCondition(event, c));
}

// ─── Main classifier (pure, deterministic) ────────────────────────────────

/**
 * Classify an event against a pre-loaded, priority-ordered rule set.
 *
 * Rules are evaluated in priority order (ascending).  The event_type of the
 * FIRST matching rule is returned.  Returns 'general' if no rule matches.
 *
 * This function is pure — no DB calls, no side effects.
 */
export function classifyEvent(
  rules: EventTypeRule[],
  event: ClassifiableEvent,
): string {
  for (const r of rules) {
    if (evaluateRule(event, r.rule)) {
      return r.eventType;
    }
  }
  return "general";
}
