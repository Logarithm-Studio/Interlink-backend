/**
 * Prompt + schema for AR (accounts-receivable) Insights — the dashboard "Brain".
 *
 * Gemini analyzes the full open/overdue book + each client's payment history and
 * returns a prioritized, risk-scored action plan with reasoning. Recommends only;
 * the user approves all sends. Uses ONLY the provided facts (PRD §5).
 */

import { z } from "zod";

export const ArInsightsSchema = z.object({
  summary: z.string().min(1),
  headlineMetrics: z.object({
    totalOutstandingCents: z.number(),
    overdueCount: z.number(),
    atRiskCount: z.number(),
  }),
  prioritizedActions: z
    .array(
      z.object({
        invoiceId: z.string(),
        clientName: z.string(),
        title: z.string(),
        reason: z.string(),
        riskScore: z.number().min(0).max(100),
        recommendedTone: z.enum(["friendly", "firm", "final"]),
      }),
    )
    .default([]),
  clientRiskNotes: z
    .array(z.object({ clientName: z.string(), note: z.string() }))
    .default([]),
});

export type ArInsights = z.infer<typeof ArInsightsSchema>;

export interface ArInvoiceFact {
  invoiceId: string;
  invoiceNumber: string;
  clientName: string;
  amountCents: number;
  currency: string;
  dueDate: string;
  daysOverdue: number;
  status: string;
  reminderCount: number;
}

export interface ClientHistoryFact {
  clientName: string;
  paidCount: number;
  avgDaysLate: number;
}

export interface ArInsightsContext {
  invoices: ArInvoiceFact[];
  history: ClientHistoryFact[];
  currency: string;
}

export function buildArInsightsPrompt(ctx: ArInsightsContext): {
  system: string;
  user: string;
} {
  const system = [
    "You are a senior accounts-receivable analyst. Analyze the open/overdue invoice book and each",
    "client's payment history, then produce a concise, prioritized collection plan.",
    "RULES:",
    "- Use ONLY the provided facts. Never invent amounts, dates, or clients.",
    "- Prioritize by collection risk and value: larger + older + clients who historically pay late rank higher.",
    "- riskScore is 0-100 (higher = chase sooner). recommendedTone ∈ friendly|firm|final based on how overdue",
    "  the invoice is and the client's late-payment history.",
    "- Keep `summary` to 1-3 sentences. Keep each `reason` to one sentence.",
    "- You recommend; you never send anything.",
    'Return ONLY JSON matching: {"summary":string,"headlineMetrics":{"totalOutstandingCents":number,',
    '"overdueCount":number,"atRiskCount":number},"prioritizedActions":[{"invoiceId":string,"clientName":string,',
    '"title":string,"reason":string,"riskScore":number,"recommendedTone":"friendly|firm|final"}],',
    '"clientRiskNotes":[{"clientName":string,"note":string}]}.',
  ].join("\n");

  const invoiceLines = ctx.invoices
    .map(
      (i) =>
        `- id=${i.invoiceId} ${i.invoiceNumber} | ${i.clientName} | ${(i.amountCents / 100).toFixed(2)} ${i.currency} | due ${i.dueDate} | ${i.daysOverdue}d overdue | status ${i.status} | reminders ${i.reminderCount}`,
    )
    .join("\n");
  const historyLines = ctx.history
    .map(
      (h) =>
        `- ${h.clientName}: paid ${h.paidCount} invoice(s), avg ${h.avgDaysLate} days late`,
    )
    .join("\n");

  const user = [
    "OPEN / OVERDUE INVOICES:",
    invoiceLines || "(none)",
    "",
    "CLIENT PAYMENT HISTORY:",
    historyLines || "(none)",
  ].join("\n");

  return { system, user };
}

export function buildFallbackArInsights(ctx: ArInsightsContext): ArInsights {
  const outstanding = ctx.invoices
    .filter((i) => i.status !== "paid")
    .reduce((s, i) => s + i.amountCents, 0);
  const overdue = ctx.invoices.filter((i) => i.daysOverdue > 0);
  const histByClient = new Map(ctx.history.map((h) => [h.clientName, h]));

  const ranked = [...overdue].sort(
    (a, b) => b.amountCents * (b.daysOverdue + 1) - a.amountCents * (a.daysOverdue + 1),
  );

  return {
    summary:
      overdue.length > 0
        ? `${overdue.length} overdue invoice(s) totaling ${(outstanding / 100).toFixed(0)} ${ctx.currency} need attention.`
        : "No overdue invoices right now.",
    headlineMetrics: {
      totalOutstandingCents: outstanding,
      overdueCount: overdue.length,
      atRiskCount: ranked.filter(
        (i) => (histByClient.get(i.clientName)?.avgDaysLate ?? 0) > 10,
      ).length,
    },
    prioritizedActions: ranked.slice(0, 5).map((i) => {
      const tone: "friendly" | "firm" | "final" =
        i.daysOverdue > 30 || i.reminderCount >= 2
          ? "final"
          : i.daysOverdue > 14
            ? "firm"
            : "friendly";
      return {
        invoiceId: i.invoiceId,
        clientName: i.clientName,
        title: `Chase ${i.clientName} — ${(i.amountCents / 100).toFixed(0)} ${i.currency}`,
        reason: `${i.daysOverdue} days overdue${histByClient.get(i.clientName)?.avgDaysLate ? `, typically pays ~${histByClient.get(i.clientName)!.avgDaysLate}d late` : ""}.`,
        riskScore: Math.min(100, 40 + i.daysOverdue + i.reminderCount * 10),
        recommendedTone: tone,
      };
    }),
    clientRiskNotes: ctx.history
      .filter((h) => h.avgDaysLate > 10)
      .map((h) => ({
        clientName: h.clientName,
        note: `Historically pays about ${h.avgDaysLate} days late.`,
      })),
  };
}
