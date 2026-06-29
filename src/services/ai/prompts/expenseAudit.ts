/**
 * Prompt + schema for Expense Auditing.
 *
 * Gemini reviews the expense ledger and returns per-expense findings (duplicates,
 * missing receipts, policy violations, miscategorizations) with reasoning. It
 * flags and explains; the user approves/dismisses. Uses ONLY provided facts.
 */

import { z } from "zod";

export const ExpenseAuditSchema = z.object({
  findings: z
    .array(
      z.object({
        expenseId: z.string(),
        issueType: z.enum([
          "duplicate",
          "missing_receipt",
          "policy_violation",
          "uncategorized",
          "unusual_amount",
          "other",
        ]),
        severity: z.enum(["low", "medium", "high"]),
        reason: z.string().min(1),
        suggestedAction: z.string().min(1),
      }),
    )
    .default([]),
});

export type ExpenseAudit = z.infer<typeof ExpenseAuditSchema>;

export interface ExpenseFact {
  expenseId: string;
  merchant: string;
  amountCents: number;
  currency: string;
  txnDate: string;
  category: string | null;
  hasReceipt: boolean;
  cardLast4: string | null;
}

export interface ExpenseAuditContext {
  expenses: ExpenseFact[];
  policy: {
    receiptRequiredOverCents: number;
    mealsReviewOverCents: number;
  };
}

export function buildExpenseAuditPrompt(ctx: ExpenseAuditContext): {
  system: string;
  user: string;
} {
  const system = [
    "You are a meticulous corporate expense auditor. Review the expense ledger and report only the",
    "expenses that warrant attention.",
    "Check for:",
    `- duplicate / near-duplicate charges (same merchant + amount within a couple of days)`,
    `- missing_receipt on charges over ${(ctx.policy.receiptRequiredOverCents / 100).toFixed(0)} (receipt required)`,
    `- policy_violation (e.g. meals/entertainment over ${(ctx.policy.mealsReviewOverCents / 100).toFixed(0)} need review)`,
    "- uncategorized expenses (no category)",
    "- unusual_amount (clearly out of pattern)",
    "RULES: Use ONLY the provided facts. Do not invent expenses. Only include expenses with a real issue.",
    "Keep `reason` and `suggestedAction` to one sentence each.",
    'Return ONLY JSON: {"findings":[{"expenseId":string,"issueType":"duplicate|missing_receipt|policy_violation|uncategorized|unusual_amount|other","severity":"low|medium|high","reason":string,"suggestedAction":string}]}.',
  ].join("\n");

  const lines = ctx.expenses
    .map(
      (e) =>
        `- id=${e.expenseId} | ${e.merchant} | ${(e.amountCents / 100).toFixed(2)} ${e.currency} | ${e.txnDate} | category=${e.category ?? "NONE"} | receipt=${e.hasReceipt ? "yes" : "NO"} | card *${e.cardLast4 ?? "----"}`,
    )
    .join("\n");

  return { system, user: `EXPENSES:\n${lines || "(none)"}` };
}

export function buildFallbackExpenseAudit(ctx: ExpenseAuditContext): ExpenseAudit {
  const findings: ExpenseAudit["findings"] = [];
  const seen = new Map<string, ExpenseFact>();

  for (const e of ctx.expenses) {
    // Duplicate by merchant+amount.
    const key = `${e.merchant}|${e.amountCents}`;
    if (seen.has(key)) {
      findings.push({
        expenseId: e.expenseId,
        issueType: "duplicate",
        severity: "high",
        reason: `Possible duplicate of another ${e.merchant} charge for the same amount.`,
        suggestedAction: "Verify this is not a double charge before approving.",
      });
    } else {
      seen.set(key, e);
    }
    // Missing receipt over threshold.
    if (!e.hasReceipt && e.amountCents > ctx.policy.receiptRequiredOverCents) {
      findings.push({
        expenseId: e.expenseId,
        issueType: "missing_receipt",
        severity: "high",
        reason: `No receipt on a ${(e.amountCents / 100).toFixed(0)} ${e.currency} charge.`,
        suggestedAction: "Request a receipt from the cardholder.",
      });
    }
    // Uncategorized.
    if (!e.category) {
      findings.push({
        expenseId: e.expenseId,
        issueType: "uncategorized",
        severity: "low",
        reason: "Expense has no category assigned.",
        suggestedAction: "Assign an accounting category.",
      });
    }
    // Meals policy.
    if (
      (e.category ?? "").toLowerCase().includes("meal") &&
      e.amountCents > ctx.policy.mealsReviewOverCents
    ) {
      findings.push({
        expenseId: e.expenseId,
        issueType: "policy_violation",
        severity: "medium",
        reason: `Meals/entertainment charge exceeds the review threshold.`,
        suggestedAction: "Confirm business purpose and attendees.",
      });
    }
  }

  return { findings };
}
