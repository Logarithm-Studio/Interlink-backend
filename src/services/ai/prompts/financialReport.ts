/**
 * Prompt + schema for the Flash Financial Report.
 *
 * Gemini reads the AR book + expense ledger and produces a concise executive
 * summary with cash-position insights and recommended actions. Uses ONLY the
 * provided aggregates (PRD §5: no invented figures).
 */

import { z } from "zod";

export const FlashReportSchema = z.object({
  summary: z.string().min(1),
  totals: z.object({
    outstandingCents: z.number(),
    overdueCents: z.number(),
    collectedCents: z.number(),
    expensesCents: z.number(),
  }),
  cashRunwayNote: z.string().min(1),
  insights: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
});

export type FlashReport = z.infer<typeof FlashReportSchema>;

export interface FlashReportContext {
  currency: string;
  outstandingCents: number;
  overdueCents: number;
  collectedCents: number;
  expensesCents: number;
  invoiceCount: number;
  overdueCount: number;
  topOverdue: { clientName: string; amountCents: number; daysOverdue: number }[];
  topExpenseCategories: { category: string; amountCents: number }[];
}

export function buildFlashReportPrompt(ctx: FlashReportContext): {
  system: string;
  user: string;
} {
  const system = [
    "You are a finance analyst writing a short daily flash report for leadership.",
    "Summarize the current AR position and spend, surface the most important insights, and recommend",
    "concrete next actions.",
    "RULES: Use ONLY the provided aggregates. Never invent numbers. Keep `summary` to 2-3 sentences,",
    "`cashRunwayNote` to one sentence, and 2-4 short bullet strings each for insights and recommendations.",
    "Echo the provided totals exactly in `totals`.",
    'Return ONLY JSON: {"summary":string,"totals":{"outstandingCents":number,"overdueCents":number,',
    '"collectedCents":number,"expensesCents":number},"cashRunwayNote":string,"insights":[string],',
    '"recommendations":[string]}.',
  ].join("\n");

  const fmt = (c: number) => `${(c / 100).toFixed(2)} ${ctx.currency}`;
  const user = [
    `Outstanding receivables: ${fmt(ctx.outstandingCents)} across ${ctx.invoiceCount} invoice(s).`,
    `Overdue: ${fmt(ctx.overdueCents)} across ${ctx.overdueCount} invoice(s).`,
    `Collected (paid to date): ${fmt(ctx.collectedCents)}.`,
    `Expenses (recent): ${fmt(ctx.expensesCents)}.`,
    "",
    "Top overdue:",
    ctx.topOverdue
      .map((o) => `- ${o.clientName}: ${fmt(o.amountCents)} (${o.daysOverdue}d overdue)`)
      .join("\n") || "(none)",
    "",
    "Top expense categories:",
    ctx.topExpenseCategories
      .map((c) => `- ${c.category}: ${fmt(c.amountCents)}`)
      .join("\n") || "(none)",
  ].join("\n");

  return { system, user };
}

export function buildFallbackFlashReport(ctx: FlashReportContext): FlashReport {
  const fmt = (c: number) => `${(c / 100).toFixed(0)} ${ctx.currency}`;
  return {
    summary: `You have ${fmt(ctx.outstandingCents)} outstanding, of which ${fmt(ctx.overdueCents)} is overdue across ${ctx.overdueCount} invoice(s). ${fmt(ctx.collectedCents)} collected to date.`,
    totals: {
      outstandingCents: ctx.outstandingCents,
      overdueCents: ctx.overdueCents,
      collectedCents: ctx.collectedCents,
      expensesCents: ctx.expensesCents,
    },
    cashRunwayNote:
      ctx.overdueCents > 0
        ? `Collecting overdue balances would add ${fmt(ctx.overdueCents)} to cash on hand.`
        : "No overdue receivables are currently impacting cash.",
    insights: [
      ctx.overdueCount > 0
        ? `${ctx.overdueCount} invoice(s) are past due.`
        : "Receivables are current.",
      ctx.topOverdue[0]
        ? `Largest overdue: ${ctx.topOverdue[0].clientName} (${fmt(ctx.topOverdue[0].amountCents)}).`
        : "No single large overdue balance.",
    ],
    recommendations:
      ctx.overdueCount > 0
        ? ["Send reminders to the most overdue accounts first.", "Review high-value overdue invoices for payment plans."]
        : ["Maintain current collection cadence."],
  };
}
