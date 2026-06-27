/**
 * Dunning service (Professional Mode — Accountant).
 *
 * Shared by the interactive API path (POST /accountant/invoices/:id/send-reminder)
 * and the weekly scan/workflow. Orchestrates: load invoice → Gemini draft →
 * Gmail draft+send → reminder log → mark invoice reminded.
 *
 * Mirrors `declineEmail.service.ts` (Personal Mode) so the UX/contract is 1:1:
 * the call is synchronous and returns the sent subject/body/recipients.
 */

import { createHash, randomUUID } from "crypto";
import { AuthError, createGmailDraft, sendGmailDraft } from "../email/gmail.service";
import { generateDunningEmail } from "../ai/ai.service";
import {
  createReminderLog,
  getInvoiceById,
  markInvoiceReminded,
  type Invoice,
} from "./invoices.service";
import { query } from "../../config/db";
import { AppUser } from "../../types";
import { BadRequestError, NotFoundError } from "../../utils/errors";

export interface SendReminderParams {
  user: AppUser;
  invoiceId: string;
}

export interface SendReminderResult {
  reminderLogId: string;
  status: "sent" | "already_sent";
  provider: "gmail";
  invoiceId: string;
  recipients: string[];
  subject: string;
  body: string;
  messageId: string;
  isAiFallback: boolean;
}

function formatAmount(amountCents: number, currency: string): string {
  const major = amountCents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

function formatDueDate(due: string): string {
  const d = new Date(`${due}T00:00:00`);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : due;
}

function daysOverdue(due: string): number {
  const d = new Date(`${due}T00:00:00`).getTime();
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.round((Date.now() - d) / 86_400_000));
}

async function loadSenderProfile(
  userId: string,
  fallbackEmail: string,
): Promise<{ name: string; company?: string }> {
  const res = await query<{ full_name: string | null; company_name: string | null }>(
    "SELECT full_name, company_name FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  const row = res.rows[0];
  const name = row?.full_name?.trim() || fallbackEmail.split("@")[0] || "Accounts Receivable";
  const company = row?.company_name?.trim() || undefined;
  return { name, company };
}

/**
 * Generate and send a dunning reminder for one invoice. Idempotent within a
 * reminder attempt; safe to retry (Gmail send guards on draft.sent_at).
 */
export async function sendInvoiceReminder(
  params: SendReminderParams,
): Promise<SendReminderResult> {
  const { user, invoiceId } = params;

  const invoice: Invoice | null = await getInvoiceById(user.id, invoiceId);
  if (!invoice) throw new NotFoundError("Invoice");

  if (invoice.status === "paid") {
    throw new BadRequestError("Invoice is already paid — nothing to remind.");
  }

  const recipient = invoice.clientEmail?.trim().toLowerCase();
  if (!recipient) {
    throw new BadRequestError("Invoice has no client email to remind.");
  }

  const sender = await loadSenderProfile(user.id, user.email);

  // ── Generate the reminder via Gemini (Professional Mode) ──────────────────
  const aiIdempotencyKey = `ai:dunning:${user.id}:${invoiceId}:${invoice.reminderCount}`;
  const generated = await generateDunningEmail({
    userId: user.id,
    idempotencyKey: aiIdempotencyKey,
    context: {
      clientName: invoice.clientName,
      invoiceNumber: invoice.invoiceNumber,
      amountFormatted: formatAmount(invoice.amountCents, invoice.currency),
      currency: invoice.currency,
      dueDateHuman: formatDueDate(invoice.dueDate),
      daysOverdue: daysOverdue(invoice.dueDate),
      reminderCount: invoice.reminderCount,
      senderName: sender.name,
      companyName: sender.company,
    },
  });

  const subject = generated.email.subject;
  const body = generated.email.body;
  const recipients = [recipient];

  // Draft key varies per reminder attempt so escalations create fresh drafts.
  const draftIdempotencyKey =
    `dunning:draft:${user.id}:${invoiceId}:${invoice.reminderCount}:` +
    createHash("sha256").update(subject + body).digest("hex").slice(0, 12);

  let sendCompleted = false;

  try {
    const draft = await createGmailDraft({
      executionId: null,
      stepId: `dunning_reminder:${invoiceId}`,
      userId: user.id,
      recipients,
      subject,
      body,
      idempotencyKey: draftIdempotencyKey,
    });

    const sendResult = await sendGmailDraft({
      executionId: `dunning:${invoiceId}`,
      stepId: `dunning_reminder:${invoiceId}`,
      userId: user.id,
      providerDraftId: draft.providerDraftId,
      idempotencyKey: `dunning:send:${user.id}:${invoiceId}:${randomUUID()}`,
    });
    sendCompleted = true;

    const log = await createReminderLog({
      userId: user.id,
      invoiceId,
      recipients,
      subject,
      body,
      status: sendResult.alreadySent ? "already_sent" : "sent",
      providerMessageId: sendResult.messageId || null,
      isAiFallback: generated.isFallback,
    });

    await markInvoiceReminded(user.id, invoiceId);

    return {
      reminderLogId: log.id,
      status: sendResult.alreadySent ? "already_sent" : "sent",
      provider: "gmail",
      invoiceId,
      recipients,
      subject,
      body,
      messageId: sendResult.messageId,
      isAiFallback: generated.isFallback,
    };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    if (!sendCompleted) {
      await createReminderLog({
        userId: user.id,
        invoiceId,
        recipients,
        subject,
        body,
        status: "failed",
        providerMessageId: null,
        isAiFallback: generated.isFallback,
        failureReason,
      }).catch(() => {});
    }
    throw error;
  }
}

export { AuthError };
