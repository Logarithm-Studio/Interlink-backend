/**
 * Accountant expenses service (Professional Mode — Expense Auditing).
 *
 * Read/write layer for the `expenses` ledger. Gemini reviews these rows
 * (`insights`/`reporting`/audit flows) and flags anomalies; the user approves or
 * dismisses. Seeded demo data includes intentional anomalies so the audit has
 * real findings.
 */

import { createHash } from "crypto";
import { query } from "../../config/db";
import { generateExpenseAudit } from "../ai/ai.service";
import type { ExpenseAudit } from "../ai/prompts/expenseAudit";

export type ExpenseStatus = "pending" | "flagged" | "approved" | "dismissed";

export interface Expense {
  id: string;
  userId: string;
  merchant: string;
  amountCents: number;
  currency: string;
  txnDate: string; // YYYY-MM-DD
  category: string | null;
  cardLast4: string | null;
  hasReceipt: boolean;
  status: ExpenseStatus;
  flagReason: string | null;
  aiAnalysis: Record<string, unknown> | null;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface ExpenseRow {
  id: string;
  user_id: string;
  merchant: string;
  amount_cents: string;
  currency: string;
  txn_date: string;
  category: string | null;
  card_last4: string | null;
  has_receipt: boolean;
  status: ExpenseStatus;
  flag_reason: string | null;
  ai_analysis: Record<string, unknown> | null;
  source: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

const EXPENSE_COLUMNS = `
  id, user_id, merchant, amount_cents, currency,
  to_char(txn_date, 'YYYY-MM-DD') AS txn_date,
  category, card_last4, has_receipt, status, flag_reason, ai_analysis,
  source, metadata, created_at, updated_at
`;

function mapExpense(r: ExpenseRow): Expense {
  return {
    id: r.id,
    userId: r.user_id,
    merchant: r.merchant,
    amountCents: Number(r.amount_cents),
    currency: r.currency,
    txnDate: r.txn_date,
    category: r.category,
    cardLast4: r.card_last4,
    hasReceipt: r.has_receipt,
    status: r.status,
    flagReason: r.flag_reason,
    aiAnalysis: r.ai_analysis,
    source: r.source,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function listExpenses(
  userId: string,
  opts?: { status?: ExpenseStatus },
): Promise<Expense[]> {
  const params: unknown[] = [userId];
  let statusClause = "";
  if (opts?.status) {
    statusClause = "AND status = $2";
    params.push(opts.status);
  }
  const result = await query<ExpenseRow>(
    `SELECT ${EXPENSE_COLUMNS} FROM expenses
      WHERE user_id = $1 ${statusClause}
      ORDER BY txn_date DESC, created_at DESC`,
    params,
  );
  return result.rows.map(mapExpense);
}

export async function getExpenseById(
  userId: string,
  expenseId: string,
): Promise<Expense | null> {
  const result = await query<ExpenseRow>(
    `SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE id = $1 AND user_id = $2`,
    [expenseId, userId],
  );
  return result.rows[0] ? mapExpense(result.rows[0]) : null;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/** Apply a Gemini audit finding to one expense (flag + reason + analysis). */
export async function applyAuditFinding(params: {
  userId: string;
  expenseId: string;
  flagReason: string;
  analysis: Record<string, unknown>;
}): Promise<void> {
  await query(
    `UPDATE expenses
        SET status = CASE WHEN status IN ('approved', 'dismissed') THEN status ELSE 'flagged' END,
            flag_reason = $3,
            ai_analysis = $4::jsonb,
            updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [params.expenseId, params.userId, params.flagReason, JSON.stringify(params.analysis)],
  );
}

/** Resolve a flagged expense (user decision). */
export async function resolveExpense(
  userId: string,
  expenseId: string,
  action: "approve" | "dismiss",
): Promise<void> {
  const status: ExpenseStatus = action === "approve" ? "approved" : "dismissed";
  await query(
    `UPDATE expenses SET status = $3, updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [expenseId, userId, status],
  );
}

// ─── AI audit orchestration ───────────────────────────────────────────────────

export interface ExpenseAuditResult {
  findings: ExpenseAudit["findings"];
  flaggedCount: number;
  isFallback: boolean;
}

/**
 * Run a Gemini audit over the user's open (pending/flagged) expenses, apply the
 * findings (flag + reason + analysis), and return them.
 */
export async function runExpenseAudit(userId: string): Promise<ExpenseAuditResult> {
  const all = await listExpenses(userId);
  const auditable = all.filter(
    (e) => e.status === "pending" || e.status === "flagged",
  );

  const context = {
    expenses: auditable.map((e) => ({
      expenseId: e.id,
      merchant: e.merchant,
      amountCents: e.amountCents,
      currency: e.currency,
      txnDate: e.txnDate,
      category: e.category,
      hasReceipt: e.hasReceipt,
      cardLast4: e.cardLast4,
    })),
    policy: { receiptRequiredOverCents: 75000, mealsReviewOverCents: 50000 },
  };

  const stateHash = createHash("sha256")
    .update(auditable.map((e) => `${e.id}:${e.amountCents}:${e.status}`).sort().join("|"))
    .digest("hex")
    .slice(0, 16);

  const result = await generateExpenseAudit({
    userId,
    idempotencyKey: `ai:expense_audit:${userId}:${stateHash}`,
    context,
  });

  const valid = new Set(auditable.map((e) => e.id));
  for (const f of result.data.findings) {
    if (!valid.has(f.expenseId)) continue; // ignore hallucinated ids
    await applyAuditFinding({
      userId,
      expenseId: f.expenseId,
      flagReason: f.reason,
      analysis: f as unknown as Record<string, unknown>,
    });
  }

  return {
    findings: result.data.findings.filter((f) => valid.has(f.expenseId)),
    flaggedCount: result.data.findings.filter((f) => valid.has(f.expenseId)).length,
    isFallback: result.isFallback,
  };
}

// ─── Create from a scanned receipt (Gemini vision) ────────────────────────────

export async function createExpenseFromReceipt(
  userId: string,
  receipt: {
    merchant: string;
    amountCents: number;
    currency: string;
    txnDate: string; // YYYY-MM-DD or ""
    category: string | null;
  },
): Promise<Expense> {
  const merchant = receipt.merchant.trim() || "Scanned receipt";
  const res = await query<{ id: string }>(
    `INSERT INTO expenses
       (user_id, merchant, amount_cents, currency, txn_date, category,
        has_receipt, status, source)
     VALUES ($1, $2, $3, $4,
             COALESCE(NULLIF($5, '')::date, CURRENT_DATE),
             $6, true, 'pending', 'receipt_scan')
     ON CONFLICT (user_id, merchant, amount_cents, txn_date) DO NOTHING
     RETURNING id`,
    [userId, merchant, receipt.amountCents, receipt.currency || "USD", receipt.txnDate, receipt.category],
  );

  let id = res.rows[0]?.id;
  if (!id) {
    const existing = await query<{ id: string }>(
      `SELECT id FROM expenses
        WHERE user_id = $1 AND merchant = $2 AND amount_cents = $3
        ORDER BY created_at DESC LIMIT 1`,
      [userId, merchant, receipt.amountCents],
    );
    id = existing.rows[0]?.id;
  }
  const created = id ? await getExpenseById(userId, id) : null;
  if (!created) throw new Error("Failed to create expense from receipt.");
  return created;
}

// ─── Demo seeding (with intentional anomalies) ────────────────────────────────

export async function seedDemoExpenses(userId: string): Promise<number> {
  // (merchant, amount_cents, txnOffset days, category|null, card_last4, has_receipt)
  const demo: [string, number, number, string | null, string, boolean][] = [
    // Near-duplicate charge (same merchant + amount, one day apart) — flag as likely duplicate.
    ["Amazon Web Services", 120000, -6, "Software", "4242", true],
    ["Amazon Web Services", 120000, -5, "Software", "4242", true],
    // Large charge with no receipt — policy violation.
    ["Apple Store", 340000, -9, "Equipment", "4242", false],
    // Uncategorized — needs categorization.
    ["SQ *UNKNOWN VENDOR", 7800, -3, null, "1009", true],
    // High-value entertainment — possible policy review.
    ["Nobu Restaurant", 86000, -4, "Meals & Entertainment", "1009", true],
    // Normal, clean expenses for contrast.
    ["WeWork", 95000, -12, "Office Rent", "4242", true],
    ["Adobe", 5499, -15, "Software", "4242", true],
    ["Delta Air Lines", 142000, -20, "Travel", "1009", true],
    ["Staples", 8200, -8, "Office Supplies", "4242", true],
  ];

  let inserted = 0;
  for (const [merchant, amount, txnOffset, category, card, hasReceipt] of demo) {
    const res = await query(
      `INSERT INTO expenses
         (user_id, merchant, amount_cents, currency, txn_date, category,
          card_last4, has_receipt, status, source)
       VALUES ($1, $2, $3, 'USD',
               CURRENT_DATE + ($4 || ' days')::interval,
               $5, $6, $7, 'pending', 'demo')
       ON CONFLICT (user_id, merchant, amount_cents, txn_date) DO NOTHING`,
      [userId, merchant, amount, txnOffset, category, card, hasReceipt],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}
