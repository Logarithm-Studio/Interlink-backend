/**
 * Prompt + schema for Gemini-vision receipt extraction (iter3).
 * Extracts structured expense fields from a receipt image. Never invents data —
 * fields it cannot read are null/empty.
 */

import { z } from "zod";

export const ReceiptExtractSchema = z.object({
  merchant: z.string().default(""),
  amountCents: z.number().int().nonnegative().default(0),
  currency: z.string().default("USD"),
  /** YYYY-MM-DD, or "" if unreadable. */
  txnDate: z.string().default(""),
  category: z.string().nullable().default(null),
  taxCents: z.number().int().nonnegative().nullable().default(null),
  lineItems: z.array(z.string()).default([]),
});

export type ReceiptExtract = z.infer<typeof ReceiptExtractSchema>;

export const RECEIPT_EXTRACT_SYSTEM = [
  "You are an expense-receipt parser. Read the attached receipt image and extract its fields.",
  "RULES:",
  "- Use ONLY what is visible in the image. Do not guess or invent values.",
  "- `amountCents` and `taxCents` are integer cents (e.g. $12.50 → 1250).",
  "- `txnDate` is YYYY-MM-DD, or \"\" if not legible.",
  "- `category` is your best single accounting category (e.g. Meals & Entertainment, Travel,",
  "  Software, Office Supplies) or null if unclear.",
  '- Return ONLY JSON: {"merchant":string,"amountCents":number,"currency":string,"txnDate":string,',
  '  "category":string|null,"taxCents":number|null,"lineItems":[string]}.',
].join("\n");

export function buildFallbackReceiptExtract(): ReceiptExtract {
  return {
    merchant: "Scanned receipt",
    amountCents: 0,
    currency: "USD",
    txnDate: "",
    category: null,
    taxCents: null,
    lineItems: [],
  };
}
