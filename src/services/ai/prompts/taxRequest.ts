/**
 * Prompt + schema for the Tax Document Gathering workflow (iter3).
 * Gemini drafts a professional W-9 / tax-form request email to a contractor.
 * Uses ONLY provided facts; no invented amounts or links (PRD §5).
 */

import { z } from "zod";

export const TaxRequestSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
});

export type TaxRequest = z.infer<typeof TaxRequestSchema>;

export interface TaxRequestContext {
  contractorName: string;
  formType: string; // e.g. "W-9"
  taxYear: number;
  ytdPaidFormatted: string; // e.g. "$2,400.00"
  senderName: string;
  companyName?: string;
}

export function buildTaxRequestPrompt(ctx: TaxRequestContext): {
  system: string;
  user: string;
} {
  const signer = ctx.companyName ? `${ctx.senderName} (${ctx.companyName})` : ctx.senderName;
  const system = [
    "You are an accounts-payable assistant requesting a tax form from a contractor for year-end filing.",
    "Write a short, polite, professional email requesting a completed form.",
    "RULES: Use ONLY the provided facts. Do not invent links, portals, deadlines, or amounts beyond what's given.",
    "Plain text only. Do not attach files.",
    `Sign as "${signer}".`,
    'Return ONLY JSON: {"subject": string, "body": string}.',
  ].join("\n");
  const user = [
    `Request a ${ctx.formType} from this contractor for tax year ${ctx.taxYear}:`,
    `- Contractor: ${ctx.contractorName}`,
    `- Total paid this year: ${ctx.ytdPaidFormatted}`,
    `- Sender: ${signer}`,
  ].join("\n");
  return { system, user };
}

export function buildFallbackTaxRequest(ctx: TaxRequestContext): TaxRequest {
  const signer = ctx.companyName ? `${ctx.senderName}\n${ctx.companyName}` : ctx.senderName;
  return {
    subject: `Action needed: ${ctx.formType} for ${ctx.taxYear} tax filing`,
    body: [
      `Hi ${ctx.contractorName},`,
      "",
      `As we close out ${ctx.taxYear}, we need a completed ${ctx.formType} on file to issue your tax documents.`,
      `Our records show ${ctx.ytdPaidFormatted} paid to you this year.`,
      "",
      `Please reply with your completed ${ctx.formType} at your earliest convenience. Let me know if you have any questions.`,
      "",
      "Thank you,",
      signer,
    ].join("\n"),
  };
}
