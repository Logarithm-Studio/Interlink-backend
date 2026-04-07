/**
 * Full Zod schemas for workflow definitions stored in `workflows.definition`.
 *
 * The minimal schema in `src/triggers/types.ts` (used during trigger evaluation
 * to fan-out to matching workflows) imports the top-level definition shape from
 * here.  This file is the single source of truth for what a workflow definition
 * looks like end-to-end.
 *
 * Step types and their config shapes are defined as a Zod discriminated union.
 * New step types (Steps 12, 15, 16, 17) extend the union without breaking
 * existing workflow definitions.
 */

import { z } from "zod";
import {
  WorkflowTriggerConfigSchema,
  WorkflowConditionSchema,
} from "../triggers/types";

// ─── Re-export shared trigger types ───────────────────────────────────────────
export { WorkflowTriggerConfigSchema, WorkflowConditionSchema };

// ─── Step definition schemas (discriminated on `type`) ────────────────────────

/** Emit a log line — useful for debugging workflow definitions. */
const LogStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("log"),
  config: z.object({
    message: z.string(),
    level: z.enum(["info", "warn", "error"]).optional().default("info"),
  }),
});

/**
 * Send a push notification (or email fallback) to the user.
 * Full implementation in Step 17. During Steps 11–16 the step
 * runs but dispatching is a no-op until Step 17 registers the handler.
 */
const NotifyStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("notify"),
  config: z.object({
    title: z.string(),
    body: z.string(),
    /** Named user-facing actions that can resume the workflow. */
    actions: z
      .array(
        z.object({
          label: z.string(),
          actionKey: z.string(),
          /** Step to route to when this action is taken. */
          nextStepId: z.string().optional(),
        }),
      )
      .optional()
      .default([]),
    /**
     * How long (seconds) to wait for a user action before timing out.
     * Defaults to 86400 (24 h) when actions are defined but no timeout is set.
     */
    timeoutSeconds: z.number().int().positive().optional(),
    /** Step to route to when timeoutSeconds elapses with no action taken. */
    timeoutNextStepId: z.string().optional(),
  }),
});

/**
 * Pause execution until a fixed ISO-8601 timestamp.
 * Full implementation in Step 12.
 */
const WaitUntilStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("wait_until"),
  config: z.object({
    /** ISO-8601 datetime string, or a dot-path into execution context. */
    until: z.string(),
    /** Step definitions say what to do after the wait completes. */
    timeoutNextStepId: z.string().optional(),
  }),
});

/**
 * Wait for an explicit user action before continuing.
 * Full implementation in Step 12.
 */
const WaitForInputStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("wait_for_input"),
  config: z.object({
    /** Seconds until the timeout route fires. */
    timeoutSeconds: z.number().int().positive(),
    /** Route taken when the timeout fires without user input. */
    timeoutNextStepId: z.string().optional(),
    /** Map from actionKey → nextStepId. */
    routes: z.record(z.string()).default({}),
  }),
});

/**
 * Conditional branch — route to `routes[routeKey]` based on a context value.
 * `routeKey` is resolved by evaluating `conditions` (first match wins).
 * Full branching is implemented in Step 12; the step definition lives here.
 */
const BranchStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("branch"),
  config: z.object({
    routes: z.record(z.string()), // { routeKey: nextStepId }
    defaultNextStepId: z.string().optional(),
    /** Ordered list of conditions — first matching key determines the route. */
    rules: z
      .array(
        z.object({
          routeKey: z.string(),
          conditions: z.array(WorkflowConditionSchema),
        }),
      )
      .default([]),
  }),
});

/**
 * Generate an email draft using AI.
 * Full implementation in Step 15.
 */
const AiGenerateEmailStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("ai_generate_email"),
  config: z.object({
    /** Dot-path into execution context for the conflict / event summary. */
    contextPath: z.string().optional(),
    recipientPath: z.string().optional(),
  }),
});

/**
 * Create an email draft in Gmail / Outlook.
 * Never auto-sends. Full implementation in Step 16.
 */
const EmailDraftCreateStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("email_draft_create"),
  config: z.object({
    /** Dot-path into context for the AI output (subject, body). */
    aiOutputPath: z.string().optional(),
    toPath: z.string().optional(),
  }),
});

/**
 * Reschedule a Google Calendar event (organizer-only).
 * The resume payload from the prior wait_for_input must include:
 * eventId, startTime, endTime, and optionally title / description / calendarId.
 */
const CalendarRescheduleStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("calendar_reschedule"),
  config: z.object({
    nextStepId: z.string().optional(),
  }),
});

/**
 * Decline a Google Calendar event (for organizer or attendee).
 * The resume payload from the prior wait_for_input must include eventId.
 */
const CalendarDeclineStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("calendar_decline"),
  config: z.object({
    nextStepId: z.string().optional(),
  }),
});

/**
 * Combined AI email generation + interactive preview step.
 * Generates a draft via AI, returns a waitSpec so the user can preview,
 * and supports unlimited regeneration loops within the same step.
 */
const EmailGeneratePreviewStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("email_generate_preview"),
  config: z.object({
    sendNextStepId: z.string().optional(),
    skipNextStepId: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    timeoutNextStepId: z.string().optional(),
    contextPath: z.string().optional(),
    recipientPath: z.string().optional(),
  }),
});

/**
 * Send an email (create draft + send) via Gmail.
 * Reads the draft content from a prior step's output in execution context.
 */
const EmailSendStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("email_send"),
  config: z.object({
    nextStepId: z.string().optional(),
    draftStepId: z.string().optional(),
    recipientPath: z.string().optional(),
  }),
});

/** Generic step for future extensibility — config is opaque jsonb. */
const GenericStepSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.unknown()).optional().default({}),
});

/**
 * Union of all known step types, with a generic catch-all so that unknown
 * step types can still be stored and loaded without parse errors.
 * Parsers that need type-specific config should narrow via `step.type`.
 */
export const WorkflowStepSchema = z.discriminatedUnion("type", [
  LogStepSchema,
  NotifyStepSchema,
  WaitUntilStepSchema,
  WaitForInputStepSchema,
  BranchStepSchema,
  AiGenerateEmailStepSchema,
  EmailDraftCreateStepSchema,
  CalendarRescheduleStepSchema,
  CalendarDeclineStepSchema,
  EmailGeneratePreviewStepSchema,
  EmailSendStepSchema,
]);

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

/**
 * For step types not yet in the discriminated union, fall back to generic.
 * This allows forward-compatible loading of definitions that include step types
 * registered only in later steps.
 */
export const AnyWorkflowStepSchema = WorkflowStepSchema.or(GenericStepSchema);
export type AnyWorkflowStep = z.infer<typeof AnyWorkflowStepSchema>;

// ─── Full workflow definition ─────────────────────────────────────────────────

/**
 * The full shape of `workflows.definition` jsonb.
 *
 * Stored as:
 * ```json
 * {
 *   "trigger": { "conditions": [...] },
 *   "steps": [{ "id": "step1", "type": "log", "config": { "message": "hi" } }]
 * }
 * ```
 */
export const WorkflowDefinitionSchema = z.object({
  trigger: WorkflowTriggerConfigSchema,
  steps: z.array(AnyWorkflowStepSchema).min(1),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
