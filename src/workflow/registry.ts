/**
 * Step handler registry — the single registry that maps `step.type` strings
 * to async handler functions.
 *
 * Architecture constraints:
 * - Handlers must be pure where possible.
 * - Any side effect (email, notification, calendar mutation) must use a
 *   service that enforces idempotency + audit logging.
 * - A completed step is never re-executed (engine guards this before calling).
 *
 * Adding a new step type:
 *   1. Define its schema in `src/workflow/definition.ts`.
 *   2. Implement the handler in `src/workflow/steps/<type>.ts`.
 *   3. Call `registerStep("my_type", handler)` from `src/workers/processors/
 *      workflow.processor.ts` (or a dedicated registration module) at startup.
 */

import { AnyWorkflowStep } from "./definition";
import { waitUntilHandler } from "./steps/wait_until";
import { waitForInputHandler } from "./steps/wait_for_input";
import { branchHandler } from "./steps/branch";
import { calendarRescheduleHandler } from "./steps/calendar_reschedule";
import { calendarDeclineHandler } from "./steps/calendar_decline";
import { emailGeneratePreviewHandler } from "./steps/email_generate_preview";
import { emailSendHandler } from "./steps/email_send";
import {
  generateEmailDraft,
  computeAiIdempotencyKey,
} from "../services/ai/ai.service";
import {
  createEmailDraft,
  AuthError,
  ProviderNotConnectedError,
} from "../services/email/email.service";
import { signActionToken } from "../security/signedActions";
import { enqueueNotification } from "../services/notifications/notification.service";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Snapshot of everything a step handler needs to act on.
 *
 * `executionContext` is the execution's `context` jsonb parsed as a plain
 * object — handlers read prior step outputs from `executionContext.outputs`.
 */
export interface StepContext {
  executionId: string;
  stepId: string;
  /** Full step definition (id, type, config). */
  stepDefinition: AnyWorkflowStep;
  /** The parsed `workflow_executions.context` jsonb. */
  executionContext: Record<string, unknown>;
  /** Zero-based retry count (0 = first attempt). */
  attempt: number;
  userId: string;
  /** Payload provided when resuming from a `wait_for_input` or `wait_until`. */
  resumePayload?: Record<string, unknown>;
}

/**
 * What a step handler returns after execution.
 *
 * `output`       — persisted to `workflow_execution_steps.output` and appended
 *                  into `workflow_executions.context.outputs[stepId]`.
 * `nextStepId`   — explicit override for what step runs next:
 *                    `undefined` = linear progression (default)
 *                    `null`      = end of workflow (mark as completed)
 *                    `string`    = jump to a named step
 * `waitSpec`     — if present, the engine pauses execution instead of
 *                  moving to the next step.  See `WaitSpec` below.
 */
export interface StepResult {
  output: Record<string, unknown>;
  nextStepId?: string | null;
  waitSpec?: WaitSpec;
}

/**
 * Instructs the engine to place the execution into a `waiting` state.
 *
 * `kind`:
 * - `"until"` — resume after `until` (ISO-8601 timestamp)
 * - `"input"` — resume after explicit user action (via workflow actions API)
 *
 * Full handling for wait specs is implemented in Step 12.
 */
export type WaitSpec =
  | { kind: "until"; until: string; timeoutNextStepId?: string }
  | {
      kind: "input";
      timeoutSeconds: number;
      timeoutNextStepId?: string;
      routes: Record<string, string>;
    };

// ─── Handler type ─────────────────────────────────────────────────────────────

export type StepHandler = (ctx: StepContext) => Promise<StepResult>;

// ─── Registry ─────────────────────────────────────────────────────────────────

const _handlers = new Map<string, StepHandler>();

/**
 * Register a handler for a given step type.
 * Call this at worker startup before any jobs are processed.
 * Re-registration (e.g. during hot reload in dev) silently replaces the handler.
 */
export function registerStep(type: string, handler: StepHandler): void {
  _handlers.set(type, handler);
}

/**
 * Look up the handler for a step type.
 * Returns `undefined` if no handler is registered.
 */
export function getHandler(type: string): StepHandler | undefined {
  return _handlers.get(type);
}

// ─── Built-in handlers ────────────────────────────────────────────────────────

/**
 * `log` step — emit a log line and continue.
 * This is the only step fully implemented here; all others are registered by
 * their respective implementation modules (Steps 12, 15, 16, 17).
 */
registerStep("log", async (ctx) => {
  const config = ctx.stepDefinition.config as {
    message?: string;
    level?: string;
  };
  const msg = config?.message ?? "(no message)";
  const level = (config?.level ?? "info") as "info" | "warn" | "error";
  console[level](
    `[workflow:log] execution=${ctx.executionId} step=${ctx.stepId} | ${msg}`,
  );
  return { output: { logged: true, message: msg } };
});

/**
 * `wait_until` step — pause until a fixed ISO-8601 timestamp.
 * Full implementation in Step 12; registered from
 * `src/workflow/steps/wait_until.ts`.
 */
registerStep("wait_until", waitUntilHandler);

/**
 * `wait_for_input` step — pause until an explicit user action.
 * Full implementation in Step 12; registered from
 * `src/workflow/steps/wait_for_input.ts`.
 */
registerStep("wait_for_input", waitForInputHandler);

// ─── Dot-path resolver ────────────────────────────────────────────────────────

/**
 * Resolve a dot-delimited path into a nested object.
 * e.g. resolveDotPath({ a: { b: 42 } }, "a.b") → 42
 * Returns `undefined` if any segment is missing or the traversal hits a
 * non-object before the path is exhausted.
 */
function resolveDotPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─── ai_generate_email step ───────────────────────────────────────────────────

/**
 * Generate a conflict-resolution email draft using the AI service.
 *
 * Step config:
 *   `contextPath`   — optional dot-path into `executionContext` for the conflict
 *                     / event summary object.  Defaults to the full context.
 *   `recipientPath` — optional dot-path to a recipient email string within the
 *                     execution context.
 *
 * Idempotency key: `ai:email_draft:<executionId>:<stepId>:<inputHash>`.
 *
 * On failure the AI service transparently falls back to a deterministic
 * template draft and marks `is_fallback = true` in `ai_outputs`.
 *
 * Full implementation: Step 15.
 */
registerStep("ai_generate_email", async (ctx) => {
  const config = ctx.stepDefinition.config as {
    contextPath?: string;
    recipientPath?: string;
  };

  // Build the context data object the AI service will work from.
  let contextData: Record<string, unknown> = ctx.executionContext;

  if (config.contextPath) {
    const resolved = resolveDotPath(ctx.executionContext, config.contextPath);
    if (
      resolved !== undefined &&
      typeof resolved === "object" &&
      !Array.isArray(resolved)
    ) {
      contextData = resolved as Record<string, unknown>;
    }
  }

  // Inject explicit recipient if a path is configured.
  if (config.recipientPath) {
    const recipient = resolveDotPath(
      ctx.executionContext,
      config.recipientPath,
    );
    if (typeof recipient === "string" && recipient.length > 0) {
      contextData = { ...contextData, recipientEmail: recipient };
    }
  }

  const idempotencyKey = computeAiIdempotencyKey(
    ctx.executionId,
    ctx.stepId,
    contextData,
  );

  const result = await generateEmailDraft({
    executionId: ctx.executionId,
    stepId: ctx.stepId,
    userId: ctx.userId,
    contextData,
    idempotencyKey,
  });

  return {
    output: {
      aiOutputId: result.aiOutputId,
      emailDraft: result.emailDraft,
      isFallback: result.isFallback,
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
    },
  };
});

// ─── email_draft_create step ─────────────────────────────────────────────────

/**
 * Create an email draft via Gmail (or Outlook in a later step).
 *
 * NEVER sends the email automatically — only creates a draft.
 *
 * Step config:
 *   `aiOutputPath`  — dot-path into executionContext for the AI-generated draft
 *                     object ({ subject, body }).  Default: resolves from the
 *                     most recent `ai_generate_email` step output.
 *   `toPath`        — dot-path to the recipient email string.  If absent the
 *                     service falls back to detecting a recipient from context.
 *   `provider`      — optional: "gmail" | "outlook".  Auto-detected when absent.
 *
 * Idempotency key: `email:draft:<executionId>:<stepId>:<recipientHash>:<subjectHash>`
 *
 * On auth failure (`AuthError`) or missing provider (`ProviderNotConnectedError`)
 * the step is marked as permanently failed (no retry).
 *
 * Full implementation: Step 16.
 */
registerStep("email_draft_create", async (ctx) => {
  const config = ctx.stepDefinition.config as {
    aiOutputPath?: string;
    toPath?: string;
    provider?: "gmail" | "outlook";
  };

  // ── Resolve subject + body ────────────────────────────────────────────────
  // Prefer an explicit aiOutputPath; fall back to scanning outputs for an
  // ai_generate_email step result.
  let subject = "";
  let body = "";

  const resolveSource = (): Record<string, unknown> | undefined => {
    if (config.aiOutputPath) {
      const resolved = resolveDotPath(
        ctx.executionContext,
        config.aiOutputPath,
      );
      if (
        resolved &&
        typeof resolved === "object" &&
        !Array.isArray(resolved)
      ) {
        return resolved as Record<string, unknown>;
      }
    }
    // Auto-discover: search outputs map for an emailDraft key.
    const outputs = ctx.executionContext.outputs as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (outputs) {
      for (const stepOutput of Object.values(outputs)) {
        const draft = stepOutput?.emailDraft as
          | Record<string, unknown>
          | undefined;
        if (draft?.subject && draft?.body) return draft;
      }
    }
    return undefined;
  };

  const source = resolveSource();
  if (source) {
    subject = typeof source.subject === "string" ? source.subject : "";
    body = typeof source.body === "string" ? source.body : "";
  }

  if (!subject || !body) {
    throw new Error(
      `email_draft_create step ${ctx.stepId}: could not resolve subject/body from ` +
        `aiOutputPath=${config.aiOutputPath ?? "(auto)"}. ` +
        "Ensure an ai_generate_email step ran before this step.",
    );
  }

  // ── Resolve recipient ─────────────────────────────────────────────────────
  let recipient = "";
  if (config.toPath) {
    const r = resolveDotPath(ctx.executionContext, config.toPath);
    if (typeof r === "string" && r.length > 0) recipient = r;
  }
  if (!recipient) {
    // Try well-known context keys.
    for (const key of ["recipientEmail", "recipient_email", "to"]) {
      const v = ctx.executionContext[key];
      if (typeof v === "string" && v.length > 0) {
        recipient = v;
        break;
      }
    }
  }
  if (!recipient) {
    throw new Error(
      `email_draft_create step ${ctx.stepId}: recipient could not be resolved. ` +
        "Set toPath in the step config or provide recipientEmail in execution context.",
    );
  }

  // ── Create draft ─────────────────────────────────────────────────────────
  try {
    const result = await createEmailDraft({
      executionId: ctx.executionId,
      stepId: ctx.stepId,
      userId: ctx.userId,
      provider: config.provider,
      recipients: [recipient],
      subject,
      body,
    });

    return {
      output: {
        emailDraftId: result.emailDraftId,
        providerDraftId: result.providerDraftId,
        provider: result.provider,
        recipient,
        subject,
        isNew: result.isNew,
      },
    };
  } catch (err) {
    if (err instanceof AuthError || err instanceof ProviderNotConnectedError) {
      // Permanent failure — rethrow as-is; engine marks step failed, no retry.
      throw err;
    }
    // Transient — rethrow for BullMQ retry.
    throw err;
  }
});

// ─── branch step ─────────────────────────────────────────────────────────────
registerStep("branch", branchHandler);

// ─── notify step ──────────────────────────────────────────────────────────────

registerStep("notify", async (ctx) => {
  const step = ctx.stepDefinition;
  if (step.type !== "notify") {
    throw new Error(`[workflow:notify] unexpected step type: ${step.type}`);
  }

  const config = step.config as {
    title: string;
    body: string;
    actions: Array<{ label: string; actionKey: string; nextStepId?: string }>;
    timeoutSeconds?: number;
    timeoutNextStepId?: string;
  };
  const { title, body, actions, timeoutSeconds, timeoutNextStepId } = config;

  // ── Resume path — user action or timeout has fired ─────────────────────
  if (ctx.resumePayload) {
    const actionKey = ctx.resumePayload.actionKey as string | undefined;
    const resumeKey = ctx.resumePayload.resumeKey as string | undefined;
    const resolvedKey = actionKey ?? resumeKey;
    const resumeReason = ctx.resumePayload.resumeReason as string | undefined;

    // Build routes map for lookup.
    const routes: Record<string, string> = {};
    for (const action of actions) {
      routes[action.actionKey] = action.nextStepId ?? "";
    }

    if (resumeReason === "timeout") {
      const nextStepId: string | null = timeoutNextStepId ?? null;
      console.log(
        `[workflow:notify] Timed out → nextStep=${nextStepId ?? "null (end)"} | execution=${ctx.executionId} step=${ctx.stepId}`,
      );
      return {
        output: { timedOut: true },
        nextStepId,
      };
    }

    if (resolvedKey) {
      const nextStepId: string | null =
        routes[resolvedKey] ?? timeoutNextStepId ?? null;
      console.log(
        `[workflow:notify] Resumed via action="${resolvedKey}" → nextStep=${nextStepId ?? "null (end)"} | execution=${ctx.executionId} step=${ctx.stepId}`,
      );
      return {
        output: { actionKey: resolvedKey, resolved: true },
        nextStepId,
      };
    }

    // Unknown resume payload — continue linearly.
    console.warn(
      `[workflow:notify] Unknown resumePayload — continuing linearly | execution=${ctx.executionId} step=${ctx.stepId}`,
      ctx.resumePayload,
    );
    return {
      output: { resumed: true, unknownPayload: true },
    };
  }

  // ── First invocation — send notification and wait ──────────────────────

  // Sign a one-time action token for each action.
  const signedActions = actions.map((action) => ({
    ...action,
    token: signActionToken({
      executionId: ctx.executionId,
      stepId: ctx.stepId,
      actionKey: action.actionKey,
    }),
  }));

  // Enqueue the push / email-fallback delivery job.
  await enqueueNotification({
    executionId: ctx.executionId,
    stepId: ctx.stepId,
    userId: ctx.userId,
    title,
    body,
    actions: signedActions,
  });

  console.log(
    `[workflow:notify] notification enqueued | execution=${ctx.executionId} step=${ctx.stepId} actions=${actions.length}`,
  );

  // If there are named actions, pause the execution until the user responds.
  if (actions.length > 0) {
    // Build routes: actionKey → nextStepId (empty string means linear progression).
    const routes: Record<string, string> = {};
    for (const action of actions) {
      routes[action.actionKey] = action.nextStepId ?? "";
    }

    return {
      output: { signedActions },
      waitSpec: {
        kind: "input" as const,
        timeoutSeconds: timeoutSeconds ?? 86400,
        timeoutNextStepId,
        routes,
      },
    };
  }

  // No actions — fire-and-forget notification, continue workflow immediately.
  return { output: { signedActions } };
});

// ─── calendar_reschedule step ────────────────────────────────────────────────
registerStep("calendar_reschedule", calendarRescheduleHandler);

// ─── calendar_decline step ───────────────────────────────────────────────────
registerStep("calendar_decline", calendarDeclineHandler);

// ─── email_generate_preview step ─────────────────────────────────────────────
registerStep("email_generate_preview", emailGeneratePreviewHandler);

// ─── email_send step ─────────────────────────────────────────────────────────
registerStep("email_send", emailSendHandler);
