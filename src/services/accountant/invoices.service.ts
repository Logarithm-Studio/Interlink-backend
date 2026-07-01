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
  paidAt: Date | null;
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
  paid_at: Date | null;
  source: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

const INVOICE_COLUMNS = `
  id, user_id, invoice_number, client_name, client_email, amount_cents, currency,
  to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
  to_char(due_date,   'YYYY-MM-DD') AS due_date,
  status, last_reminder_at, reminder_count, paid_at, source, metadata, created_at, updated_at
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
    paidAt: r.paid_at,
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

/** Manually create an invoice (entered in the app). Auto-numbers if omitted. */
export async function createInvoice(
  userId: string,
  data: {
    clientName: string;
    clientEmail?: string;
    amountCents: number;
    dueDate?: string; // YYYY-MM-DD
    invoiceNumber?: string;
    currency?: string;
  },
): Promise<Invoice> {
  const number = data.invoiceNumber?.trim() || `INV-${Date.now().toString().slice(-6)}`;
  const res = await query<{ id: string }>(
    `INSERT INTO invoices
       (user_id, invoice_number, client_name, client_email, amount_cents, currency,
        issue_date, due_date, status, source)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE,
             COALESCE(NULLIF($7, '')::date, CURRENT_DATE + INTERVAL '14 days'),
             CASE WHEN COALESCE(NULLIF($7, '')::date, CURRENT_DATE + INTERVAL '14 days') < CURRENT_DATE
                  THEN 'overdue' ELSE 'open' END,
             'manual')
     ON CONFLICT (user_id, invoice_number) DO NOTHING
     RETURNING id`,
    [userId, number, data.clientName.trim(), data.clientEmail ?? null, data.amountCents, data.currency ?? "USD", data.dueDate ?? ""],
  );
  let id = res.rows[0]?.id;
  if (!id) {
    const existing = await query<{ id: string }>(
      `SELECT id FROM invoices WHERE user_id = $1 AND invoice_number = $2 LIMIT 1`,
      [userId, number],
    );
    id = existing.rows[0]?.id;
  }
  const inv = id ? await getInvoiceById(userId, id) : null;
  if (!inv) throw new Error("Failed to create invoice.");
  return inv;
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
  // (number, client, amount_cents, issueOffset, dueOffset, status, paidOffset|null)
  // paidOffset (days from today) is set for `paid` rows — historical rows below
  // establish each client's payment behaviour (Acme/Initech pay late; Globex/Stark on time).
  const demo: [string, string, number, number, number, InvoiceStatus, number | null][] = [
    // ── Current open / overdue book ──────────────────────────────────────────
    ["INV-1001", "Acme Corp", 480000, -45, -15, "overdue", null],
    ["INV-1002", "Globex LLC", 125000, -38, -8, "overdue", null],
    ["INV-1003", "Initech", 92000, -60, -30, "overdue", null],
    ["INV-1004", "Umbrella Inc", 256000, -10, 5, "open", null],
    ["INV-1005", "Stark Industries", 740000, -5, 20, "open", null],
    ["INV-1006", "Wayne Enterprises", 310000, -90, -60, "paid", -52],
    // ── Paid history (relationship signal for AI insights + dunning tone) ─────
    ["INV-0901", "Acme Corp", 300000, -120, -90, "paid", -68], // ~22 days late
    ["INV-0902", "Acme Corp", 220000, -150, -120, "paid", -95], // ~25 days late
    ["INV-0903", "Globex LLC", 80000, -130, -100, "paid", -101], // on time
    ["INV-0904", "Initech", 110000, -140, -110, "paid", -75], // ~35 days late
    ["INV-0905", "Stark Industries", 500000, -100, -70, "paid", -72], // on time
  ];

  let inserted = 0;
  for (const [number, client, amount, issueOffset, dueOffset, status, paidOffset] of demo) {
    const res = await query(
      `INSERT INTO invoices
         (user_id, invoice_number, client_name, client_email, amount_cents,
          currency, issue_date, due_date, status, source, paid_at)
       VALUES ($1, $2, $3, $4, $5, 'USD',
               CURRENT_DATE + ($6 || ' days')::interval,
               CURRENT_DATE + ($7 || ' days')::interval,
               $8, 'demo',
               CASE WHEN $9::text IS NULL THEN NULL
                    ELSE (CURRENT_DATE + ($9::text || ' days')::interval) END)
       ON CONFLICT (user_id, invoice_number) DO NOTHING`,
      [userId, number, client, clientEmail, amount, issueOffset, dueOffset, status, paidOffset],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}
