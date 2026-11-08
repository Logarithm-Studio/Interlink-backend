/**
 * Flash Financial Reporting service (Professional Mode).
 *
 * Aggregates the AR book + expense ledger and asks Gemini for an executive
 * summary with insights + recommendations. Can also email the report to the user.
 */

import { createHash, randomUUID } from "crypto";
import { BadRequestError } from "../../utils/errors";
import { query } from "../../config/db";
import { generateFlashReport } from "../ai/ai.service";
import type { FlashReport } from "../ai/prompts/financialReport";
import { createGmailDraft, sendGmailDraft } from "../email/gmail.service";
import { listInvoices } from "./invoices.service";
import { AppUser } from "../../types";

function daysOverdue(due: string): number {
  const d = new Date(`${due}T00:00:00`).getTime();
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.round((Date.now() - d) / 86_400_000));
}

export interface FlashReportResponse {
  currency: string;
  report: FlashReport;
  isFallback: boolean;
  generatedAt: string;
}

async function gatherContext(userId: string, selectedCurrency?: string) {
  const allInvoices = await listInvoices(userId);
  const expenseCurrencies = await query<{ currency: string }>("SELECT DISTINCT currency FROM expenses WHERE user_id=$1", [userId]);
  const currencies = new Set([...allInvoices.map(invoice => invoice.currency), ...expenseCurrencies.rows.map(row => row.currency)]);
  if (!selectedCurrency && currencies.size > 1) throw new BadRequestError("This book has multiple currencies. Use Autolink to request a flash report for one currency; amounts will not be converted or combined.");
  const currency = selectedCurrency?.trim().toUpperCase() || allInvoices[0]?.currency || expenseCurrencies.rows[0]?.currency || "USD";
  if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestError("Choose a three-letter report currency.");
  const invoices = allInvoices.filter(invoice => invoice.currency === currency);

  const active = invoices.filter((i) => i.status !== "paid");
  const overdue = active.filter((i) => daysOverdue(i.dueDate) > 0);
  const paid = invoices.filter((i) => i.status === "paid");

  const outstandingCents = active.reduce((s, i) => s + i.amountCents, 0);
  const overdueCents = overdue.reduce((s, i) => s + i.amountCents, 0);
  const collectedCents = paid.reduce((s, i) => s + i.amountCents, 0);

  const expRes = await query<{ total: string; category: string | null; cat_total: string }>(
    `SELECT category,
            SUM(amount_cents)::text AS cat_total,
            (SELECT SUM(amount_cents) FROM expenses WHERE user_id = $1 AND currency=$2)::text AS total
       FROM expenses
      WHERE user_id = $1 AND currency=$2
      GROUP BY category
      ORDER BY SUM(amount_cents) DESC`,
    [userId, currency],
  );
  const expensesCents = Number(expRes.rows[0]?.total ?? 0);
  const topExpenseCategories = expRes.rows.slice(0, 5).map((r) => ({
    category: r.category ?? "Uncategorized",
    amountCents: Number(r.cat_total),
  }));

  const topOverdue = [...overdue]
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 5)
    .map((i) => ({
      clientName: i.clientName,
      amountCents: i.amountCents,
      daysOverdue: daysOverdue(i.dueDate),
    }));

  return {
    currency,
    outstandingCents,
    overdueCents,
    collectedCents,
    expensesCents,
    invoiceCount: active.length,
    overdueCount: overdue.length,
    topOverdue,
    topExpenseCategories,
  };
}

export async function getFlashReport(userId: string, currency?: string): Promise<FlashReportResponse> {
  const context = await gatherContext(userId, currency);
  const dayBucket = new Date().toISOString().slice(0, 10);
  const result = await generateFlashReport({
    userId,
    idempotencyKey: `ai:flash:${userId}:${dayBucket}:${createHash("sha256").update(JSON.stringify(context)).digest("hex").slice(0,16)}`,
    context,
  });
  return {
    currency: context.currency,
    report: { ...result.data, totals: { outstandingCents: context.outstandingCents, overdueCents: context.overdueCents, collectedCents: context.collectedCents, expensesCents: context.expensesCents } },
    isFallback: result.isFallback,
    generatedAt: new Date().toISOString(),
  };
}

/** Email the flash report to the user's own inbox via Gmail. */
export async function emailFlashReport(
  user: AppUser,
  currency?: string,
): Promise<{ sent: boolean; messageId: string }> {
  const { report } = await getFlashReport(user.id, currency);

  const body = [
    "Flash Financial Report",
    "",
    report.summary,
    "",
    report.cashRunwayNote,
    "",
    "Insights:",
    ...report.insights.map((i) => `- ${i}`),
    "",
    "Recommended actions:",
    ...report.recommendations.map((r) => `- ${r}`),
  ].join("\n");

  const subject = `Flash Financial Report — ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
  const idempotencyKey = `flash:email:${user.id}:${new Date().toISOString().slice(0, 10)}:${createHash("sha256").update(subject + body).digest("hex").slice(0,16)}`;

  const draft = await createGmailDraft({
    executionId: null,
    stepId: `flash_report:${user.id}`,
    userId: user.id,
    recipients: [user.email],
    subject,
    body,
    idempotencyKey,
  });
  const send = await sendGmailDraft({
    executionId: `flash:${user.id}`,
    stepId: `flash_report:${user.id}`,
    userId: user.id,
    providerDraftId: draft.providerDraftId,
    idempotencyKey: `flash:send:${user.id}:${randomUUID()}`,
  });

  return { sent: true, messageId: send.messageId };
}
