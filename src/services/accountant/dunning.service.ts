/**
 * Dunning service (Professional Mode — Accountant).
 *
 * Orchestrates: load invoice → (history-aware) Gemini draft → Gmail draft+send →
 * reminder log → mark invoice reminded. Mirrors `declineEmail.service.ts` so the
 * interactive send stays synchronous and returns the sent subject/body/recipients.
 *
 * Iteration 2 adds: history/relationship-aware drafts + AI-chosen escalation tone,
 * a preview path (generate without sending), edited-draft overrides on send, and
 * bulk preview/send across overdue invoices.
 */

import { createHash, randomUUID } from "crypto";
import { AuthError, createGmailDraft, sendGmailDraft } from "../email/gmail.service";
import { generateDunningEmail } from "../ai/ai.service";
import type { EscalationTone } from "../ai/prompts/dunningReminder";
import {
  createReminderLog,
  getInvoiceById,
  listInvoices,
  markInvoiceReminded,
  type Invoice,
} from "./invoices.service";
import { query } from "../../config/db";
import { AppUser } from "../../types";
import { BadRequestError, NotFoundError } from "../../utils/errors";

export interface SendReminderParams {
  user: AppUser;
  invoiceId: string;
  /** Edited draft overrides (skip AI generation when both provided). */
  subjectOverride?: string;
  bodyOverride?: string;
  /** Optional tone override (e.g. from an AR-insights recommendation). */
  escalationTone?: EscalationTone;
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

export interface ReminderDraft {
  invoiceId: string;
  clientName: string;
  subject: string;
  body: string;
  isAiFallback: boolean;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatAmount(amountCents: number, currency: string): string {
  const major = amountCents / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(major);
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

/** How this client has historically paid (relationship signal for tone). */
export async function loadClientHistory(
  userId: string,
  clientName: string,
): Promise<{ paidCount: number; avgDaysLate: number }> {
  const res = await query<{ paid_count: string; avg_days_late: string }>(
    `SELECT COUNT(*) AS paid_count,
            COALESCE(AVG(GREATEST(0, (paid_at::date - due_date))), 0) AS avg_days_late
       FROM invoices
      WHERE user_id = $1 AND client_name = $2
        AND status = 'paid' AND paid_at IS NOT NULL`,
    [userId, clientName],
  );
  const row = res.rows[0];
  return {
    paidCount: parseInt(row?.paid_count ?? "0", 10),
    avgDaysLate: Math.round(parseFloat(row?.avg_days_late ?? "0")),
  };
}

// ─── Draft generation ─────────────────────────────────────────────────────────

async function generateDraftForInvoice(
  user: AppUser,
  invoice: Invoice,
  opts?: { regenerate?: boolean; escalationTone?: EscalationTone },
): Promise<ReminderDraft> {
  const sender = await loadSenderProfile(user.id, user.email);
  const history = await loadClientHistory(user.id, invoice.clientName);

  const baseKey = `ai:dunning:${user.id}:${invoice.id}:${invoice.reminderCount}`;
  const idempotencyKey = opts?.regenerate ? `${baseKey}:${randomUUID()}` : baseKey;

  const generated = await generateDunningEmail({
    userId: user.id,
    idempotencyKey,
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
      escalationTone: opts?.escalationTone,
      avgDaysLatePaid: history.avgDaysLate,
      priorPaidCount: history.paidCount,
    },
  });

  return {
    invoiceId: invoice.id,
    clientName: invoice.clientName,
    subject: generated.email.subject,
    body: generated.email.body,
    isAiFallback: generated.isFallback,
  };
}

/** Generate a reminder draft WITHOUT sending (for preview/edit). */
export async function previewReminder(
  user: AppUser,
  invoiceId: string,
  opts?: { regenerate?: boolean; escalationTone?: EscalationTone },
): Promise<ReminderDraft> {
  const invoice = await getInvoiceById(user.id, invoiceId);
  if (!invoice) throw new NotFoundError("Invoice");
  if (invoice.status === "paid") {
    throw new BadRequestError("Invoice is already paid — nothing to remind.");
  }
  if (!invoice.clientEmail?.trim()) {
    throw new BadRequestError("Invoice has no client email to remind.");
  }
  return generateDraftForInvoice(user, invoice, opts);
}

// ─── Send ─────────────────────────────────────────────────────────────────────

/**
 * Generate (or use edited) reminder and send it. Idempotent within an attempt;
 * safe to retry (Gmail send guards on draft.sent_at).
 */
export async function sendInvoiceReminder(
  params: SendReminderParams,
): Promise<SendReminderResult> {
  const { user, invoiceId } = params;

  const invoice = await getInvoiceById(user.id, invoiceId);
  if (!invoice) throw new NotFoundError("Invoice");
  if (invoice.status === "paid") {
    throw new BadRequestError("Invoice is already paid — nothing to remind.");
  }
  const recipient = invoice.clientEmail?.trim().toLowerCase();
  if (!recipient) {
    throw new BadRequestError("Invoice has no client email to remind.");
  }

  // Use the edited draft when both fields are provided; otherwise generate.
  const useOverride =
    typeof params.subjectOverride === "string" &&
    params.subjectOverride.trim().length > 0 &&
    typeof params.bodyOverride === "string" &&
    params.bodyOverride.trim().length > 0;

  let subject: string;
  let body: string;
  let isAiFallback = false;

  if (useOverride) {
    subject = params.subjectOverride!.trim();
    body = params.bodyOverride!.trim();
  } else {
    const draft = await generateDraftForInvoice(user, invoice, {
      escalationTone: params.escalationTone,
    });
    subject = draft.subject;
    body = draft.body;
    isAiFallback = draft.isAiFallback;
  }

  const recipients = [recipient];
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
      isAiFallback,
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
      isAiFallback,
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
        isAiFallback,
        failureReason,
      }).catch(() => {});
    }
    throw error;
  }
}

// ─── Bulk ──────────────────────────────────────────────────────────────────────

/** Generate tailored drafts for every overdue/reminded invoice (or a given set). */
export async function bulkPreviewReminders(
  user: AppUser,
  invoiceIds?: string[],
): Promise<ReminderDraft[]> {
  let targets: Invoice[];
  if (invoiceIds && invoiceIds.length > 0) {
    const loaded = await Promise.all(
      invoiceIds.map((id) => getInvoiceById(user.id, id)),
    );
    targets = loaded.filter((i): i is Invoice => i !== null && i.status !== "paid");
  } else {
    const all = await listInvoices(user.id);
    targets = all.filter((i) => i.status === "overdue" || i.status === "reminded");
  }

  const drafts: ReminderDraft[] = [];
  for (const invoice of targets) {
    if (!invoice.clientEmail?.trim()) continue;
    drafts.push(await generateDraftForInvoice(user, invoice));
  }
  return drafts;
}

export interface BulkSendItem {
  invoiceId: string;
  subject?: string;
  body?: string;
}

export interface BulkSendOutcome {
  invoiceId: string;
  ok: boolean;
  status?: "sent" | "already_sent";
  error?: string;
}

/** Send a reviewed batch of reminders; per-invoice failures don't abort the rest. */
export async function bulkSendReminders(
  user: AppUser,
  items: BulkSendItem[],
): Promise<BulkSendOutcome[]> {
  const outcomes: BulkSendOutcome[] = [];
  for (const item of items) {
    try {
      const res = await sendInvoiceReminder({
        user,
        invoiceId: item.invoiceId,
        subjectOverride: item.subject,
        bodyOverride: item.body,
      });
      outcomes.push({ invoiceId: item.invoiceId, ok: true, status: res.status });
    } catch (err) {
      outcomes.push({
        invoiceId: item.invoiceId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

export { AuthError };
