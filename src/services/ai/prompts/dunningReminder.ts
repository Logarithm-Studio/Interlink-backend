/**
 * Prompt + schema for the Accountant "Dunning & Invoice Reminders" workflow.
 *
 * Gemini (Professional Mode) drafts a polite-but-firm payment reminder from the
 * invoice facts only. Per PRD §5 the model must never invent amounts, dates, or
 * links. Output is JSON-only and validated against `DunningEmailSchema`; on any
 * failure the deterministic `buildFallbackDunningEmail` template is used.
 */

import { z } from "zod";

// ─── Output schema ────────────────────────────────────────────────────────────

export const DunningEmailSchema = z.object({
  subject: z.string().min(1, "subject must be a non-empty string"),
  body: z.string().min(1, "body must be a non-empty string"),
});

export type DunningEmail = z.infer<typeof DunningEmailSchema>;

// ─── Prompt context ───────────────────────────────────────────────────────────

export interface DunningEmailContext {
  clientName: string;
  invoiceNumber: string;
  amountFormatted: string; // e.g. "$4,800.00"
  currency: string;
  dueDateHuman: string; // e.g. "March 1, 2026"
  daysOverdue: number;
  /** 0 = first reminder. Escalates tone as it grows. */
  reminderCount: number;
  senderName: string;
  companyName?: string;
}

function escalationGuidance(reminderCount: number): string {
  if (reminderCount <= 0)
    return "This is the FIRST reminder — warm, friendly, assume good faith (it may be an oversight).";
  if (reminderCount === 1)
    return "This is a SECOND reminder — still polite but a little more direct about the outstanding balance.";
  if (reminderCount === 2)
    return "This is a THIRD reminder — firm and clear that payment is now significantly overdue.";
  return "This is a FINAL notice — professional but firm, noting that this is the last reminder before escalation.";
}

/**
 * Build the system + user prompt for a dunning reminder email.
 */
export function buildDunningPrompt(ctx: DunningEmailContext): {
  system: string;
  user: string;
} {
  const signer = ctx.companyName
    ? `${ctx.senderName} (${ctx.companyName})`
    : ctx.senderName;

  const system = [
    "You are a professional accounts-receivable assistant drafting a payment-reminder (dunning) email.",
    "Write a clear, courteous, professional reminder for an overdue invoice.",
    "STRICT RULES:",
    "- Use ONLY the facts provided. Never invent amounts, dates, invoice numbers, payment links, portals, or bank details.",
    "- Do not include any URLs or attachments.",
    "- Plain text only (no markdown, no HTML).",
    `- Sign the email as "${signer}".`,
    `- Tone: ${escalationGuidance(ctx.reminderCount)}`,
    'Return ONLY a JSON object: {"subject": string, "body": string}.',
  ].join("\n");

  const user = [
    "Draft a payment reminder email with these facts:",
    `- Client: ${ctx.clientName}`,
    `- Invoice number: ${ctx.invoiceNumber}`,
    `- Amount due: ${ctx.amountFormatted} ${ctx.currency}`,
    `- Due date: ${ctx.dueDateHuman}`,
    `- Days overdue: ${ctx.daysOverdue}`,
    `- Sender: ${signer}`,
  ].join("\n");

  return { system, user };
}

// ─── Deterministic fallback ─────────────────────────────────────────────────

/**
 * Build a dunning email without AI (used on provider failure / invalid output).
 * Always returns a valid `DunningEmail`.
 */
export function buildFallbackDunningEmail(ctx: DunningEmailContext): DunningEmail {
  const signer = ctx.companyName
    ? `${ctx.senderName}\n${ctx.companyName}`
    : ctx.senderName;

  const opener =
    ctx.reminderCount <= 0
      ? "I hope you're well. This is a friendly reminder that the invoice below is now past due."
      : "I'm following up again regarding the outstanding invoice below, which remains unpaid.";

  const body = [
    `Hi ${ctx.clientName},`,
    "",
    opener,
    "",
    `Invoice: ${ctx.invoiceNumber}`,
    `Amount due: ${ctx.amountFormatted} ${ctx.currency}`,
    `Due date: ${ctx.dueDateHuman} (${ctx.daysOverdue} days overdue)`,
    "",
    "If payment has already been sent, please disregard this message. Otherwise, we'd appreciate settlement at your earliest convenience. Please reach out if you have any questions about this invoice.",
    "",
    "Thank you,",
    signer,
  ].join("\n");

  return {
    subject: `Payment reminder: Invoice ${ctx.invoiceNumber} (${ctx.amountFormatted} overdue)`,
    body,
  };
}
