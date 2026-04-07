/**
 * Prompt builder for calendar-conflict email-draft generation.
 *
 * Produces a `{ system, user }` prompt pair that the AI provider receives.
 * The system prompt constrains the output strictly to JSON matching
 * `EmailDraftSchema` — no prose, no markdown, no extra fields.
 *
 * Prompt design rules (per plan §8.6):
 * - Single-pass: no chain-of-thought or multi-turn.
 * - "Return JSON only. No prose." is the first instruction.
 * - A concrete JSON schema is provided so the model cannot misinterpret it.
 * - Context is minimal and factual; no secrets are included.
 * - Temperature is fixed at 0 by the provider (deterministic).
 */

// ─── Context types ────────────────────────────────────────────────────────────

export interface ConflictEmailContext {
  eventATitle: string;
  eventAStart: string;
  eventAEnd: string;
  eventBTitle: string;
  eventBStart: string;
  eventBEnd: string;
  conflictType: "overlap" | "buffer_violation";
  overlapMinutes: number;
  severity: "high" | "medium" | "low";
  /** Email of the calendar owner — used as the implicit sender. */
  userEmail: string;
  /** Optional target recipient if derivable from context. */
  recipientEmail?: string;
  /** Optional meeting notes supplied by the user. */
  meetingNotes?: string;
  /** Optional tone preference (e.g., formal, friendly, concise). */
  tonePreference?: string;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build the system + user prompt pair for conflict email generation.
 */
export function buildEmailConflictPrompt(ctx: ConflictEmailContext): {
  system: string;
  user: string;
} {
  const schema = JSON.stringify(
    {
      subject: "string",
      body: "string",
      reason: "string",
      proposed_times: ["string"],
    },
    null,
    2,
  );

  const system = [
    "Return JSON only. No prose. No markdown. No explanation.",
    "Return a valid JSON object that exactly matches this schema:",
    schema,
    "",
    "Schema constraints:",
    "- subject: concise email subject line (max 80 chars)",
    "- body: polite plain-text email body (no HTML, no markdown formatting, no backticks)",
    "- reason: one internal sentence explaining why this email is being drafted",
    "- proposed_times: array of human-readable alternative meeting time suggestions; may be [] if no times can be inferred",
    "- If a tone preference is provided (e.g., formal, friendly), match that tone; otherwise default to polite and clear",
    "- If meeting notes are provided, incorporate them succinctly",
    "",
    "Do NOT add any fields beyond the four listed above.",
    "Do NOT wrap the JSON in a code block or add any surrounding text.",
  ].join("\n");

  const conflictLabel =
    ctx.conflictType === "buffer_violation"
      ? "buffer window violation (events too close together)"
      : "direct time overlap";

  const lines: string[] = [
    `Conflict type: ${conflictLabel}`,
    `Severity: ${ctx.severity}`,
    `Overlap duration: ${ctx.overlapMinutes} minutes`,
    "",
    `Event A: "${ctx.eventATitle}"`,
    `  Starts: ${ctx.eventAStart}`,
    `  Ends:   ${ctx.eventAEnd}`,
    "",
    `Event B: "${ctx.eventBTitle}"`,
    `  Starts: ${ctx.eventBStart}`,
    `  Ends:   ${ctx.eventBEnd}`,
    "",
    `Calendar owner: ${ctx.userEmail}`,
  ];

  if (ctx.recipientEmail) {
    lines.push(`Recipient email: ${ctx.recipientEmail}`);
  }

  if (ctx.tonePreference) {
    lines.push(`Tone preference: ${ctx.tonePreference}`);
  }

  if (ctx.meetingNotes) {
    lines.push("", "Meeting notes from user:", ctx.meetingNotes);
  }

  lines.push("", "Draft the conflict notification email.");

  const user = lines.join("\n");

  return { system, user };
}
