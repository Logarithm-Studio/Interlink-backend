/**
 * `email_send` workflow step — sends an email via Gmail (create draft → send).
 *
 * Reads the email draft content from the prior step's output in execution
 * context (typically from `email_generate_preview`). Resolves the recipients
 * from context or step config.
 *
 * Recipient resolution order:
 *  1. `recipientEmails` (string[]) from the prior `email_generate_preview` output.
 *  2. `recipientEmail` (string) from the prior step's output (backwards compat).
 *  3. `recipientPath` step config — dot-path resolving to string or string[].
 *  4. Auto-extract from event attendees:
 *       a. Read conflicting event IDs from `trigger.conflict.conflictingEvents`.
 *       b. Query `events.attendees` JSONB for those events.
 *       c. Collect all unique attendee emails.
 *       d. Look up the workflow user's own email.
 *       e. Filter out the user's own email (they are the sender, not a recipient).
 *
 * Uses `sendEmail()` from `email.service.ts` which creates a Gmail draft and
 * immediately sends it via `users.drafts.send`, providing a full audit trail.
 *
 * Step config:
 *   - `nextStepId`     — explicit next step (overrides linear ordering)
 *   - `draftStepId`    — step ID whose output contains { emailDraft }
 *   - `recipientPath`  — dot-path into execution context for recipient email(s)
 */

import { query } from "../../config/db";
import { sendEmail } from "../../services/email/email.service";
import type { StepContext, StepResult } from "../registry";

interface EmailSendConfig {
  nextStepId?: string;
  draftStepId?: string;
  recipientPath?: string;
}

function resolveDotPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export async function emailSendHandler(ctx: StepContext): Promise<StepResult> {
  const config = ctx.stepDefinition.config as EmailSendConfig;

  const outputs = (ctx.executionContext.outputs ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  // ── Resolve email draft content ───────────────────────────────────────────
  // Look in a specific step's output or scan all outputs for an emailDraft.
  let subject = "";
  let body = "";
  let recipients: string[] = [];

  const resolveFromStep = (stepId: string): boolean => {
    const stepOutput = outputs[stepId];
    if (!stepOutput) return false;

    const draft = stepOutput.emailDraft as Record<string, unknown> | undefined;
    if (draft?.subject && draft?.body) {
      subject = draft.subject as string;
      body = draft.body as string;
    } else if (stepOutput.subject && stepOutput.body) {
      subject = stepOutput.subject as string;
      body = stepOutput.body as string;
    }

    // Prefer the array form produced by the updated email_generate_preview step.
    if (
      Array.isArray(stepOutput.recipientEmails) &&
      (stepOutput.recipientEmails as unknown[]).length > 0
    ) {
      recipients = (stepOutput.recipientEmails as unknown[]).filter(
        (e): e is string => typeof e === "string" && e.length > 0,
      );
    } else if (
      typeof stepOutput.recipientEmail === "string" &&
      stepOutput.recipientEmail.length > 0
    ) {
      recipients = [stepOutput.recipientEmail as string];
    }

    return Boolean(subject && body);
  };

  if (config.draftStepId) {
    resolveFromStep(config.draftStepId);
  }

  // Fall back: scan all outputs for an emailDraft
  if (!subject || !body) {
    for (const [stepId, stepOutput] of Object.entries(outputs)) {
      if (stepId === ctx.stepId) continue;
      const draft = stepOutput?.emailDraft as
        | Record<string, unknown>
        | undefined;
      if (draft?.subject && draft?.body) {
        subject = draft.subject as string;
        body = draft.body as string;
        if (
          Array.isArray(stepOutput.recipientEmails) &&
          (stepOutput.recipientEmails as unknown[]).length > 0
        ) {
          recipients = (stepOutput.recipientEmails as unknown[]).filter(
            (e): e is string => typeof e === "string" && e.length > 0,
          );
        } else if (
          typeof stepOutput.recipientEmail === "string" &&
          stepOutput.recipientEmail.length > 0
        ) {
          recipients = [stepOutput.recipientEmail as string];
        }
        break;
      }
    }
  }

  if (!subject || !body) {
    throw new Error(
      `email_send step ${ctx.stepId}: could not find email draft content. ` +
        "Ensure an ai_generate_email or email_generate_preview step ran before.",
    );
  }

  // ── Resolve recipients ────────────────────────────────────────────────────

  // 1. recipientPath config override (supports both a string and a string[]).
  if (recipients.length === 0 && config.recipientPath) {
    const r = resolveDotPath(ctx.executionContext, config.recipientPath);
    if (typeof r === "string" && r.length > 0) {
      recipients = [r];
    } else if (
      Array.isArray(r) &&
      r.length > 0 &&
      r.every((x) => typeof x === "string")
    ) {
      recipients = r as string[];
    }
  }

  // 2. Try common flat context keys (single-address backwards compat).
  if (recipients.length === 0) {
    for (const key of ["recipientEmail", "recipient_email", "to"]) {
      const v = ctx.executionContext[key];
      if (typeof v === "string" && v.length > 0) {
        recipients = [v];
        break;
      }
    }
  }

  // 3. Auto-extract from event attendees — the correct multi-recipient path.
  if (recipients.length === 0) {
    recipients = await resolveRecipientsFromEvents(ctx);
  }

  if (recipients.length === 0) {
    throw new Error(
      `email_send step ${ctx.stepId}: recipient could not be resolved. ` +
        "Provide recipientEmail/recipientEmails in execution context, set " +
        "recipientPath in step config, or ensure the trigger payload contains " +
        "conflictingEvents with attendees.",
    );
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  const result = await sendEmail({
    executionId: ctx.executionId,
    stepId: ctx.stepId,
    userId: ctx.userId,
    recipients,
    subject,
    body,
  });

  console.log(
    `[workflow:email_send] email sent to ${recipients.join(", ")} | ` +
      `execution=${ctx.executionId} step=${ctx.stepId} messageId=${result.messageId}`,
  );

  return {
    output: {
      emailDraftId: result.emailDraftId,
      providerDraftId: result.providerDraftId,
      messageId: result.messageId,
      threadId: result.threadId,
      provider: result.provider,
      recipients,
      /** @deprecated Use `recipients` array. */
      recipientEmail: recipients[0] ?? null,
      subject,
      sent: true,
      alreadySent: result.alreadySent,
    },
    nextStepId: config.nextStepId,
  };
}

// ─── Attendee extraction helper ───────────────────────────────────────────────

/**
 * Derive the send-to list from the conflicting events stored in the DB.
 *
 * Steps:
 *  1. Find conflicting event IDs from `trigger.conflict.conflictingEvents`.
 *  2. Query `events.attendees` (JSONB) for those event rows.
 *  3. Collect all unique attendee emails across both events.
 *  4. Look up the workflow user's own email from `users`.
 *  5. Remove the user's own email — they are the SENDER, not a recipient.
 */
async function resolveRecipientsFromEvents(
  ctx: StepContext,
): Promise<string[]> {
  // Extract event IDs from the trigger payload.
  const trigger = ctx.executionContext.trigger as
    | Record<string, unknown>
    | undefined;
  const conflict = (trigger?.conflict ?? ctx.executionContext.conflict) as
    | Record<string, unknown>
    | undefined;

  const conflictingEvents = conflict?.conflictingEvents as string[] | undefined;

  if (!conflictingEvents || conflictingEvents.length === 0) {
    return [];
  }

  // Query the events table for attendee lists of all conflicting events.
  const eventsRes = await query<{ attendees: unknown }>(
    `SELECT attendees
       FROM events
      WHERE id = ANY($1::uuid[]) AND user_id = $2`,
    [conflictingEvents, ctx.userId],
  );

  const seen = new Set<string>();
  const allAttendees: string[] = [];

  for (const row of eventsRes.rows) {
    const attendeeList = Array.isArray(row.attendees) ? row.attendees : [];
    for (const attendee of attendeeList) {
      const email =
        typeof attendee === "object" && attendee !== null
          ? (attendee as Record<string, unknown>).email
          : attendee;
      if (typeof email === "string" && email.length > 0 && !seen.has(email)) {
        seen.add(email);
        allAttendees.push(email);
      }
    }
  }

  if (allAttendees.length === 0) {
    return [];
  }

  // Look up the user's own email so we can exclude it.
  const userRes = await query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1 LIMIT 1",
    [ctx.userId],
  );
  const userEmail = userRes.rows[0]?.email?.toLowerCase() ?? "";

  // Filter out the current user — they're the sender, not a recipient.
  const external = allAttendees.filter((e) => e.toLowerCase() !== userEmail);

  if (external.length === 0) {
    console.warn(
      `[workflow:email_send] All attendees of the conflicting events match ` +
        `the workflow user (${userEmail}). No external recipients found. ` +
        `Execution=${ctx.executionId} step=${ctx.stepId}`,
    );
  }

  return external;
}
