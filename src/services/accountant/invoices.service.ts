/**
 * Accountant invoices service (Professional Mode).
 *
 * Read/write layer for the `invoices` accounts-receivable ledger and the
 * `invoice_reminder_logs` dunning send log. All access is parameterized SQL via
 * the shared `query()` helper — same pattern as `events.service.ts`.
 *
 * Iteration 1 uses seeded demo data (POST /accountant/seed-demo); real
 * QuickBooks/Stripe/Plaid adapters can populate the same table later.
 */

import { query } from "../../config/db";

// ─── Types ────────────────────────────────────────────────────────────────────

export type InvoiceStatus = "open" | "overdue" | "reminded" | "paid";

export interface Invoice {
  id: string;
  userId: string;
  invoiceNumber: string;
  clientName: string;
  clientEmail: string;
  amountCents: number;
  currency: string;
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  status: InvoiceStatus;
  lastReminderAt: Date | null;
  reminderCount: number;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReminderLog {
  id: string;
  invoiceId: string;
  recipients: string[];
  subject: string;
  body: string;
  status: "sent" | "already_sent" | "failed";
  providerMessageId: string | null;
  isAiFallback: boolean;
  failureReason: string | null;
  createdAt: Date;
}

interface InvoiceRow {
  id: string;
  user_id: string;
  invoice_number: string;
  client_name: string;
  client_email: string;
  amount_cents: string; // bigint comes back as string from pg
  currency: string;
  issue_date: string;
  due_date: string;
  status: InvoiceStatus;
  last_reminder_at: Date | null;
  reminder_count: number;
  source: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

const INVOICE_COLUMNS = `
  id, user_id, invoice_number, client_name, client_email, amount_cents, currency,
  to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
  to_char(due_date,   'YYYY-MM-DD') AS due_date,
  status, last_reminder_at, reminder_count, source, metadata, created_at, updated_at
`;

function mapInvoice(r: InvoiceRow): Invoice {
  return {
    id: r.id,
    userId: r.user_id,
    invoiceNumber: r.invoice_number,
    clientName: r.client_name,
    clientEmail: r.client_email,
    amountCents: Number(r.amount_cents),
    currency: r.currency,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    status: r.status,
    lastReminderAt: r.last_reminder_at,
    reminderCount: r.reminder_count,
    source: r.source,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** List a user's invoices, optionally filtered by status, ordered by due date. */
export async function listInvoices(
  userId: string,
  opts?: { status?: InvoiceStatus },
): Promise<Invoice[]> {
  const params: unknown[] = [userId];
  let statusClause = "";
  if (opts?.status) {
    statusClause = "AND status = $2";
    params.push(opts.status);
  }

  const result = await query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS}
       FROM invoices
      WHERE user_id = $1 ${statusClause}
      ORDER BY due_date ASC, created_at ASC`,
    params,
  );
  return result.rows.map(mapInvoice);
}

export async function getInvoiceById(
  userId: string,
  invoiceId: string,
): Promise<Invoice | null> {
  const result = await query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = $1 AND user_id = $2`,
    [invoiceId, userId],
  );
  return result.rows[0] ? mapInvoice(result.rows[0]) : null;
}

export async function countOverdue(userId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM invoices
      WHERE user_id = $1 AND status IN ('overdue', 'reminded')`,
    [userId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Mark every `open` invoice whose due date has passed as `overdue`.
 * Returns the number of rows transitioned. Used by the weekly scan.
 */
export async function markOverdueInvoices(userId: string): Promise<number> {
  const result = await query(
    `UPDATE invoices
        SET status = 'overdue', updated_at = now()
      WHERE user_id = $1 AND status = 'open' AND due_date < CURRENT_DATE`,
    [userId],
  );
  return result.rowCount ?? 0;
}

/** Flag an invoice as reminded after a successful dunning send. */
export async function markInvoiceReminded(
  userId: string,
  invoiceId: string,
): Promise<void> {
  await query(
    `UPDATE invoices
        SET status = 'reminded',
            last_reminder_at = now(),
            reminder_count = reminder_count + 1,
            updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [invoiceId, userId],
  );
}

// ─── Reminder logs ────────────────────────────────────────────────────────────

export async function createReminderLog(params: {
  userId: string;
  invoiceId: string;
  recipients: string[];
  subject: string;
  body: string;
  status: "sent" | "already_sent" | "failed";
  providerMessageId?: string | null;
  isAiFallback?: boolean;
  failureReason?: string | null;
}): Promise<{ id: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO invoice_reminder_logs
       (user_id, invoice_id, recipients, subject, body, status,
        provider_message_id, is_ai_fallback, failure_reason)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      params.userId,
      params.invoiceId,
      JSON.stringify(params.recipients),
      params.subject,
      params.body,
      params.status,
      params.providerMessageId ?? null,
      params.isAiFallback ?? false,
      params.failureReason ?? null,
    ],
  );
  return { id: result.rows[0].id };
}

export async function getReminderLogs(
  userId: string,
  invoiceId: string,
): Promise<ReminderLog[]> {
  const result = await query<{
    id: string;
    invoice_id: string;
    recipients: string[];
    subject: string;
    body: string;
    status: "sent" | "already_sent" | "failed";
    provider_message_id: string | null;
    is_ai_fallback: boolean;
    failure_reason: string | null;
    created_at: Date;
  }>(
    `SELECT id, invoice_id, recipients, subject, body, status,
            provider_message_id, is_ai_fallback, failure_reason, created_at
       FROM invoice_reminder_logs
      WHERE user_id = $1 AND invoice_id = $2
      ORDER BY created_at DESC`,
    [userId, invoiceId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoice_id,
    recipients: Array.isArray(r.recipients) ? r.recipients : [],
    subject: r.subject,
    body: r.body,
    status: r.status,
    providerMessageId: r.provider_message_id,
    isAiFallback: r.is_ai_fallback,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
  }));
}

// ─── Demo seeding ─────────────────────────────────────────────────────────────

/**
 * Seed a realistic set of demo invoices for a user (idempotent on
 * (user_id, invoice_number)). Demo invoices are addressed to the user's own
 * email so dunning sends are verifiable in the tester's inbox.
 *
 * Returns the number of rows actually inserted.
 */
export async function seedDemoInvoices(
  userId: string,
  clientEmail: string,
): Promise<number> {
  // (number, client, amount_cents, issue offset days, due offset days, status)
  const demo: [string, string, number, number, number, InvoiceStatus][] = [
    ["INV-1001", "Acme Corp", 480000, -45, -15, "overdue"],
    ["INV-1002", "Globex LLC", 125000, -38, -8, "overdue"],
    ["INV-1003", "Initech", 92000, -60, -30, "overdue"],
    ["INV-1004", "Umbrella Inc", 256000, -10, 5, "open"],
    ["INV-1005", "Stark Industries", 740000, -5, 20, "open"],
    ["INV-1006", "Wayne Enterprises", 310000, -90, -60, "paid"],
  ];

  let inserted = 0;
  for (const [number, client, amount, issueOffset, dueOffset, status] of demo) {
    const res = await query(
      `INSERT INTO invoices
         (user_id, invoice_number, client_name, client_email, amount_cents,
          currency, issue_date, due_date, status, source)
       VALUES ($1, $2, $3, $4, $5, 'USD',
               CURRENT_DATE + ($6 || ' days')::interval,
               CURRENT_DATE + ($7 || ' days')::interval,
               $8, 'demo')
       ON CONFLICT (user_id, invoice_number) DO NOTHING`,
      [userId, number, client, clientEmail, amount, issueOffset, dueOffset, status],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}
