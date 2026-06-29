/**
 * AR Insights service (Professional Mode).
 *
 * Gathers the open/overdue book + each client's payment history and asks Gemini
 * for a prioritized, risk-scored collection plan. Cached per book-state so it
 * regenerates when the receivables actually change.
 */

import { createHash } from "crypto";
import { generateArInsights } from "../ai/ai.service";
import type { ArInsights } from "../ai/prompts/arInsights";
import { listInvoices } from "./invoices.service";
import { loadClientHistory } from "./dunning.service";

function daysOverdue(due: string): number {
  const d = new Date(`${due}T00:00:00`).getTime();
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.round((Date.now() - d) / 86_400_000));
}

export interface ArInsightsResponse {
  insights: ArInsights;
  isFallback: boolean;
  generatedAt: string;
}

export async function getArInsights(userId: string): Promise<ArInsightsResponse> {
  const all = await listInvoices(userId);
  const active = all.filter((i) => i.status !== "paid");
  const currency = all[0]?.currency ?? "USD";

  const invoices = active.map((i) => ({
    invoiceId: i.id,
    invoiceNumber: i.invoiceNumber,
    clientName: i.clientName,
    amountCents: i.amountCents,
    currency: i.currency,
    dueDate: i.dueDate,
    daysOverdue: daysOverdue(i.dueDate),
    status: i.status,
    reminderCount: i.reminderCount,
  }));

  // Distinct clients in the active book → payment history.
  const clients = [...new Set(active.map((i) => i.clientName))];
  const history = await Promise.all(
    clients.map(async (clientName) => {
      const h = await loadClientHistory(userId, clientName);
      return { clientName, paidCount: h.paidCount, avgDaysLate: h.avgDaysLate };
    }),
  );

  // Cache key reflects the book state so insights refresh when it changes.
  const stateHash = createHash("sha256")
    .update(
      invoices
        .map((i) => `${i.invoiceId}:${i.status}:${i.daysOverdue}:${i.reminderCount}`)
        .sort()
        .join("|"),
    )
    .digest("hex")
    .slice(0, 16);

  const result = await generateArInsights({
    userId,
    idempotencyKey: `ai:insights:${userId}:${stateHash}`,
    context: { invoices, history, currency },
  });

  return {
    insights: result.data,
    isFallback: result.isFallback,
    generatedAt: new Date().toISOString(),
  };
}
