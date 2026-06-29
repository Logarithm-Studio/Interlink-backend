/**
 * Flash Financial Reporting service (Professional Mode).
 *
 * Aggregates the AR book + expense ledger and asks Gemini for an executive
 * summary with insights + recommendations. Can also email the report to the user.
 */

import { randomUUID } from "crypto";
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
  report: FlashReport;
  isFallback: boolean;
  generatedAt: string;
}

async function gatherContext(userId: string) {
  const invoices = await listInvoices(userId);
  const currency = invoices[0]?.currency ?? "USD";

  const active = invoices.filter((i) => i.status !== "paid");
  const overdue = active.filter((i) => daysOverdue(i.dueDate) > 0);
  const paid = invoices.filter((i) => i.status === "paid");

  const outstandingCents = active.reduce((s, i) => s + i.amountCents, 0);
  const overdueCents = overdue.reduce((s, i) => s + i.amountCents, 0);
  const collectedCents = paid.reduce((s, i) => s + i.amountCents, 0);

  const expRes = await query<{ total: string; category: string | null; cat_total: string }>(
    `SELECT category,
            SUM(amount_cents)::text AS cat_total,
            (SELECT SUM(amount_cents) FROM expenses WHERE user_id = $1)::text AS total
       FROM expenses
      WHERE user_id = $1
      GROUP BY category
      ORDER BY SUM(amount_cents) DESC`,
    [userId],
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

export async function getFlashReport(userId: string): Promise<FlashReportResponse> {
  const context = await gatherContext(userId);
  const dayBucket = new Date().toISOString().slice(0, 10);
  const result = await generateFlashReport({
    userId,
    idempotencyKey: `ai:flash:${userId}:${dayBucket}`,
    context,
  });
  return {
    report: result.data,
    isFallback: result.isFallback,
    generatedAt: new Date().toISOString(),
  };
}

/** Email the flash report to the user's own inbox via Gmail. */
export async function emailFlashReport(
  user: AppUser,
): Promise<{ sent: boolean; messageId: string }> {
  const { report } = await getFlashReport(user.id);

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
  const idempotencyKey = `flash:email:${user.id}:${new Date().toISOString().slice(0, 10)}`;

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
