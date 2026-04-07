/**
 * Zod schemas for AI-generated output types.
 *
 * Every schema here has a corresponding fallback builder that produces a
 * deterministic output when the AI provider fails or returns invalid JSON.
 * The AI service validates provider responses against these schemas before
 * persisting or returning them.
 */

import { z } from "zod";

// ─── Email draft ──────────────────────────────────────────────────────────────

/**
 * Expected JSON shape from the AI provider when generating a conflict email.
 */
export const EmailDraftSchema = z.object({
  subject: z.string().min(1, "subject must be a non-empty string"),
  body: z.string().min(1, "body must be a non-empty string"),
  reason: z
    .string()
    .describe(
      "Internal one-sentence explanation of why this draft was produced",
    ),
  proposed_times: z
    .array(z.string())
    .describe("Human-readable alternative time suggestions (may be empty)"),
});

export type EmailDraft = z.infer<typeof EmailDraftSchema>;

// ─── Fallback context ─────────────────────────────────────────────────────────

export interface FallbackContext {
  eventATitle?: string;
  eventBTitle?: string;
  conflictType?: "overlap" | "buffer_violation";
  overlapMinutes?: number;
  recipientEmail?: string;
  meetingNotes?: string;
}

/**
 * Build a deterministic email draft without AI.
 *
 * Used when:
 *   - The provider times out or rate-limits.
 *   - The provider returns a response that is not valid JSON.
 *   - The parsed JSON does not satisfy `EmailDraftSchema`.
 *
 * The output is always a valid `EmailDraft` and is persisted with
 * `is_fallback = true` in `ai_outputs`.
 */
export function buildFallbackEmailDraft(ctx: FallbackContext): EmailDraft {
  const a = ctx.eventATitle ?? "Event A";
  const b = ctx.eventBTitle ?? "Event B";
  const overlapDesc =
    ctx.overlapMinutes && ctx.overlapMinutes > 0
      ? ` There is a ${ctx.overlapMinutes}-minute overlap.`
      : "";
  const conflictDesc =
    ctx.conflictType === "buffer_violation"
      ? "These events are too close together, violating your calendar buffer preference."
      : `"${a}" and "${b}" overlap on your calendar.${overlapDesc}`;

  const body = [
    "Hi,",
    "",
    `I wanted to reach out about a scheduling conflict between "${a}" and "${b}".`,
    conflictDesc,
    "",
    "Could we find a time that works for everyone? I am happy to adjust.",
    ctx.meetingNotes ? `\nAdditional notes: ${ctx.meetingNotes}\n` : "",
    "",
    "Best regards",
  ].join("\n");

  return {
    subject: `Scheduling Conflict: ${a} and ${b}`,
    body,
    reason:
      "Deterministic fallback template — AI generation was unavailable or returned invalid output.",
    proposed_times: [],
  };
}
