/**
 * Canonical trigger payload schemas for the workflow trigger pipeline.
 *
 * Every trigger emitted into the `triggers` queue must conform to one of
 * these types.  The `triggerType` string is what links a trigger to a
 * matching workflow row (`workflows.trigger_type`).
 */

import { z } from "zod";

// ─── Trigger type constants ────────────────────────────────────────────────

export const TriggerType = {
  CALENDAR_EVENT_UPSERTED: "calendar.event.upserted",
  CALENDAR_EVENT_DELETED: "calendar.event.deleted",
  CALENDAR_CONFLICT_DETECTED: "calendar.conflict.detected",
} as const;

export type TriggerTypeValue = (typeof TriggerType)[keyof typeof TriggerType];

// ─── Per-trigger payload schemas ───────────────────────────────────────────

/** Emitted after an event is inserted or updated in the `events` table. */
export const CalendarEventUpsertedSchema = z.object({
  triggerType: z.literal(TriggerType.CALENDAR_EVENT_UPSERTED),
  userId: z.string().uuid(),
  event: z.object({
    id: z.string(),
    externalEventId: z.string(),
    provider: z.enum(["google", "microsoft"]),
    eventType: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    startTime: z.string(), // ISO-8601
    endTime: z.string(), // ISO-8601
    organizerEmail: z.string().nullable(),
    isRecurring: z.boolean(),
  }),
  wasUpdated: z.boolean(), // true = UPDATE, false = INSERT
  observedAt: z.string(), // ISO-8601
});

/** Emitted after an event is hard-deleted from the `events` table. */
export const CalendarEventDeletedSchema = z.object({
  triggerType: z.literal(TriggerType.CALENDAR_EVENT_DELETED),
  userId: z.string().uuid(),
  event: z.object({
    id: z.string().optional(),
    externalEventId: z.string(),
    provider: z.enum(["google", "microsoft"]),
  }),
  observedAt: z.string(), // ISO-8601
});

/** Emitted by the conflict engine (Step 13). */
export const CalendarConflictDetectedSchema = z.object({
  triggerType: z.literal(TriggerType.CALENDAR_CONFLICT_DETECTED),
  userId: z.string().uuid(),
  conflict: z.object({
    /** Stable UUID from the `conflicts` table — present for new/changed conflicts. */
    conflictId: z.string().uuid().optional(),
    conflictingEvents: z.array(z.string()),
    conflictType: z.enum(["overlap", "buffer_violation"]),
    severity: z.enum(["low", "medium", "high"]),
    overlapMinutes: z.number(),
    isNew: z.boolean().optional(), // true = row was just inserted
    severityChanged: z.boolean().optional(), // true = severity changed on this pass
  }),
  observedAt: z.string(), // ISO-8601
});

/** Discriminated union of all supported trigger payloads. */
export const TriggerPayloadSchema = z.discriminatedUnion("triggerType", [
  CalendarEventUpsertedSchema,
  CalendarEventDeletedSchema,
  CalendarConflictDetectedSchema,
]);

export type TriggerPayload = z.infer<typeof TriggerPayloadSchema>;
export type CalendarEventUpserted = z.infer<typeof CalendarEventUpsertedSchema>;
export type CalendarEventDeleted = z.infer<typeof CalendarEventDeletedSchema>;
export type CalendarConflictDetected = z.infer<
  typeof CalendarConflictDetectedSchema
>;

// ─── Workflow definition shape (subset used for trigger evaluation) ────────

/**
 * A single condition evaluated against a flattened trigger payload.
 *
 * `field` uses dot-path notation relative to the trigger payload root,
 * e.g. `"event.eventType"`, `"event.title"`, `"conflict.severity"`.
 */
export const WorkflowConditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum([
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "exists",
    "not_exists",
  ]),
  value: z.unknown().optional(),
  caseSensitive: z.boolean().optional().default(false),
});

export type WorkflowCondition = z.infer<typeof WorkflowConditionSchema>;

/**
 * The `trigger` block inside `workflows.definition` jsonb.
 * All conditions are evaluated with AND semantics.
 */
export const WorkflowTriggerConfigSchema = z.object({
  conditions: z.array(WorkflowConditionSchema).optional().default([]),
});

/**
 * Minimal step shape inside `workflows.definition`.
 * The runner (Step 11) will extend this with full step semantics.
 */
export const WorkflowStepDefinitionSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
});

/**
 * Top-level shape of `workflows.definition` jsonb column.
 */
export const WorkflowDefinitionSchema = z.object({
  trigger: WorkflowTriggerConfigSchema,
  steps: z.array(WorkflowStepDefinitionSchema).min(1),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
