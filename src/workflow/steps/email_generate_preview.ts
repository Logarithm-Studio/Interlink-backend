/**
 * `email_generate_preview` workflow step — AI email generation with
 * interactive preview and unlimited regeneration.
 *
 * Combines what would otherwise be three separate steps (ai_generate_email,
 * wait_for_input/preview, ai_generate_email/regenerate) into a single step
 * that can loop internally.  This is possible because the workflow engine
 * allows a step to return another `waitSpec` on resume, keeping the step in
 * `waiting` status until the user makes a final decision.
 *
 * Lifecycle:
 *   1. First invocation (no resumePayload):
 *      - Extract conflict + event context from execution context.
 *      - Call AI provider to generate the email draft.
 *      - Return the draft as output + a `waitSpec` (kind: "input") so the
 *        frontend can display the preview.
 *
 *   2. Resume with `actionKey: "send_email"`:
 *      - Return the draft, route to `sendNextStepId`.
 *
 *   3. Resume with `actionKey: "regenerate_email"`:
 *      - The user may provide updated `tonePreference`, `meetingNotes`, or
 *        `recipientEmail` in the resume payload.
 *      - Call AI again (with a `regenerateCount` bump for a fresh idempotency
 *        key) and return the new draft + another `waitSpec` (loop).
 *
 *   4. Resume with `actionKey: "skip_email"`:
 *      - Return output with `skipped: true`, route to `skipNextStepId`.
 *
 * Step config:
 *   - `sendNextStepId`   — step to advance to when user sends (default: linear next)
 *   - `skipNextStepId`   — step to advance to when user skips (default: linear next)
 *   - `timeoutSeconds`   — how long to wait for user input (default: 86400 = 24h)
 *   - `timeoutNextStepId`— step to route to on timeout (default: engine handles)
 *   - `contextPath`      — optional dot-path into execution context for AI input
 *   - `recipientPath`    — optional dot-path for recipient email
 */

import {
  generateEmailDraft,
  computeAiIdempotencyKey,
} from "../../services/ai/ai.service";
import { query } from "../../config/db";
import type { StepContext, StepResult } from "../registry";

interface EmailGeneratePreviewConfig {
  sendNextStepId?: string;
  skipNextStepId?: string;
  timeoutSeconds?: number;
  timeoutNextStepId?: string;
  contextPath?: string;
  recipientPath?: string;
}

// ─── Dot-path resolver (same as registry.ts) ───────────────────────────────

function resolveDotPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function emailGeneratePreviewHandler(
  ctx: StepContext,
): Promise<StepResult> {
  const config = ctx.stepDefinition.config as EmailGeneratePreviewConfig;

  // ── Resume paths ──────────────────────────────────────────────────────────
  if (ctx.resumePayload) {
    const actionKey = (ctx.resumePayload.actionKey ??
      ctx.resumePayload.resumeKey) as string | undefined;

    // ── Send ─────────────────────────────────────────────────────────────
    if (actionKey === "send_email") {
      // Return the previously generated draft from execution context.
      const prevOutput =
        ((
          ctx.executionContext.outputs as Record<
            string,
            Record<string, unknown>
          >
        )?.[ctx.stepId] as Record<string, unknown>) ?? {};

      return {
        output: { ...prevOutput, sendApproved: true },
        nextStepId: config.sendNextStepId,
      };
    }

    // ── Skip ─────────────────────────────────────────────────────────────
    if (actionKey === "skip_email") {
      return {
        output: { skipped: true },
        nextStepId: config.skipNextStepId,
      };
    }

    // ── Regenerate (fall through to generate again) ──────────────────────
    // The user may provide new tonePreference / meetingNotes in resumePayload.
    // We merge those into the context for the AI call below.
  }

  // ── Guard: skip if no external attendees ─────────────────────────────────
  // Only run on the initial invocation (not resume/regenerate): if the
  // conflicting events have no attendees other than the user themselves,
  // there is nobody to email — skip straight to skipNextStepId.
  if (!ctx.resumePayload) {
    const externalAttendees = await resolveExternalAttendees(ctx);
    if (externalAttendees.length === 0) {
      console.log(
        `[workflow:email_generate_preview] no external attendees found — skipping email step | ` +
          `execution=${ctx.executionId} step=${ctx.stepId}`,
      );
      return {
        output: {
          skipped: true,
          skippedReason: "no_external_attendees",
        },
        nextStepId: config.skipNextStepId,
      };
    }
  }

  // ── Generate email via AI ─────────────────────────────────────────────────

  // Determine regeneration count so the AI idempotency key is unique each time.
  const prevOutput =
    ((
      ctx.executionContext.outputs as Record<string, Record<string, unknown>>
    )?.[ctx.stepId] as Record<string, unknown>) ?? {};
  const prevRegenCount =
    typeof prevOutput.regenerateCount === "number"
      ? prevOutput.regenerateCount
      : 0;
  const regenerateCount = ctx.resumePayload ? prevRegenCount + 1 : 0;

  // Build AI context data from execution context + resume payload overrides.
  let contextData: Record<string, unknown> = { ...ctx.executionContext };

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

  // Merge user-provided overrides from resume payload (tone, notes, recipient).
  if (ctx.resumePayload) {
    const rp = ctx.resumePayload;
    if (rp.tonePreference)
      contextData = { ...contextData, tonePreference: rp.tonePreference };
    if (rp.meetingNotes)
      contextData = { ...contextData, meetingNotes: rp.meetingNotes };
    // Support both a single address and a pre-built list.
    if (rp.recipientEmail)
      contextData = { ...contextData, recipientEmail: rp.recipientEmail };
    if (Array.isArray(rp.recipientEmails) && rp.recipientEmails.length > 0)
      contextData = { ...contextData, recipientEmails: rp.recipientEmails };
  }

  if (config.recipientPath) {
    const recipient = resolveDotPath(
      ctx.executionContext,
      config.recipientPath,
    );
    if (typeof recipient === "string" && recipient.length > 0) {
      contextData = { ...contextData, recipientEmail: recipient };
    } else if (
      Array.isArray(recipient) &&
      recipient.length > 0 &&
      recipient.every((r) => typeof r === "string")
    ) {
      // recipientPath resolved to a string array — store as recipientEmails.
      contextData = {
        ...contextData,
        recipientEmails: recipient as string[],
        // Also set recipientEmail to the first for backwards compat with AI prompt.
        recipientEmail: (recipient as string[])[0],
      };
    }
  }

  // Add regenerateCount to ensure a distinct idempotency key each generation.
  const aiInputData = { ...contextData, _regenerateCount: regenerateCount };

  const idempotencyKey = computeAiIdempotencyKey(
    ctx.executionId,
    ctx.stepId,
    aiInputData,
  );

  const result = await generateEmailDraft({
    executionId: ctx.executionId,
    stepId: ctx.stepId,
    userId: ctx.userId,
    contextData,
    idempotencyKey,
  });

  console.log(
    `[workflow:email_generate_preview] draft generated (gen #${regenerateCount}) | ` +
      `execution=${ctx.executionId} step=${ctx.stepId} isFallback=${result.isFallback}`,
  );

  // Build the recipient list for the output:
  //  - If contextData already has a recipientEmails array, use it.
  //  - Else if it has a single recipientEmail string, wrap it in an array.
  //  - Otherwise default to empty (email_send will resolve from event attendees).
  const recipientEmails: string[] = Array.isArray(contextData.recipientEmails)
    ? (contextData.recipientEmails as string[]).filter(
        (e): e is string => typeof e === "string" && e.length > 0,
      )
    : typeof contextData.recipientEmail === "string" &&
        (contextData.recipientEmail as string).length > 0
      ? [contextData.recipientEmail as string]
      : [];

  const output = {
    aiOutputId: result.aiOutputId,
    emailDraft: result.emailDraft,
    isFallback: result.isFallback,
    model: result.model,
    provider: result.provider,
    latencyMs: result.latencyMs,
    regenerateCount,
    /** @deprecated Use `recipientEmails` array instead. */
    recipientEmail: recipientEmails[0] ?? null,
    recipientEmails,
  };

  // Return a waitSpec so the engine enters "waiting" and the frontend can
  // display the preview.  The user can then send, regenerate, or skip.
  return {
    output,
    waitSpec: {
      kind: "input" as const,
      timeoutSeconds: config.timeoutSeconds ?? 86400,
      timeoutNextStepId: config.timeoutNextStepId,
      routes: {
        send_email: config.sendNextStepId ?? "",
        regenerate_email: "", // loops on same step
        skip_email: config.skipNextStepId ?? "",
      },
    },
  };
}

// ─── External attendee resolver ───────────────────────────────────────────────

/**
 * Query the conflicting events for external attendees (everyone except the
 * workflow user).  Used as an upfront guard before calling the AI.
 */
async function resolveExternalAttendees(ctx: StepContext): Promise<string[]> {
  const trigger = ctx.executionContext.trigger as
    | Record<string, unknown>
    | undefined;
  const conflict = (trigger?.conflict ?? ctx.executionContext.conflict) as
    | Record<string, unknown>
    | undefined;
  const conflictingEvents = conflict?.conflictingEvents as string[] | undefined;

  if (!conflictingEvents || conflictingEvents.length === 0) return [];

  const eventsRes = await query<{ attendees: unknown }>(
    `SELECT attendees FROM events WHERE id = ANY($1::uuid[]) AND user_id = $2`,
    [conflictingEvents, ctx.userId],
  );

  const userRes = await query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1 LIMIT 1",
    [ctx.userId],
  );
  const userEmail = userRes.rows[0]?.email?.toLowerCase() ?? "";

  const seen = new Set<string>();
  const external: string[] = [];

  for (const row of eventsRes.rows) {
    const attendeeList = Array.isArray(row.attendees) ? row.attendees : [];
    for (const attendee of attendeeList) {
      const email =
        typeof attendee === "object" && attendee !== null
          ? (attendee as Record<string, unknown>).email
          : attendee;
      if (
        typeof email === "string" &&
        email.length > 0 &&
        email.toLowerCase() !== userEmail &&
        !seen.has(email)
      ) {
        seen.add(email);
        external.push(email);
      }
    }
  }

  return external;
}
