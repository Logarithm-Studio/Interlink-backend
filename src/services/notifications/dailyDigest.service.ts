/**
 * Daily digest — the "come back to Interlink" notification.
 *
 * WHY: the app previously only ever fired *local* per-event reminders. Nothing brought a user
 * back for anything else: overdue invoices, a lead going cold, compliance due, a conflicted
 * calendar. This builds one short, high-signal push per day per user, assembled from data
 * Interlink already owns, and delivered through the existing `deliverNotification` path
 * (FCM push + email fallback + idempotent delivery records).
 *
 * PRINCIPLE — never notify for nothing. If a user has no calendar events today and nothing
 * needs attention, we send NOTHING. A daily "you have 0 things" push trains people to swipe
 * the app away, which is the opposite of the goal.
 */

import { query } from "../../config/db";
import { logger } from "../../observability/logger";
import { deliverNotification } from "./notification.service";

export interface DigestLine {
  /** Short clause for the notification body, e.g. "3 meetings today". */
  text: string;
  /** Higher wins when trimming to fit a notification. */
  weight: number;
}

export interface DailyDigest {
  userId: string;
  title: string;
  body: string;
  /** False when there's genuinely nothing worth interrupting the user for. */
  hasContent: boolean;
}

const startOfTodayUtc = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const endOfTodayUtc = () => {
  const d = new Date();
  d.setUTCHours(23, 59, 59, 999);
  return d;
};

/** Count today's calendar events. */
async function todaysEvents(userId: string): Promise<number> {
  try {
    const res = await query<{ n: string }>(
      `SELECT COUNT(*) n FROM events
        WHERE user_id = $1 AND start_time >= $2 AND start_time <= $3`,
      [userId, startOfTodayUtc().toISOString(), endOfTodayUtc().toISOString()],
    );
    return parseInt(res.rows[0]?.n ?? "0", 10);
  } catch {
    return 0;
  }
}

/** Overdue receivables (Financial Advisor). */
async function overdueInvoices(userId: string): Promise<{ count: number; cents: number }> {
  try {
    const res = await query<{ n: string; total: string | null }>(
      `SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) total FROM invoices
        WHERE user_id = $1 AND status IN ('overdue','reminded')`,
      [userId],
    );
    return {
      count: parseInt(res.rows[0]?.n ?? "0", 10),
      cents: parseInt(res.rows[0]?.total ?? "0", 10),
    };
  } catch {
    return { count: 0, cents: 0 };
  }
}

/** Buyer leads that are still warm and unworked (Real Estate). */
async function activeLeads(userId: string): Promise<number> {
  try {
    const res = await query<{ n: string }>(
      `SELECT COUNT(*) n FROM re_leads
        WHERE user_id = $1 AND stage IN ('new','qualified')`,
      [userId],
    );
    return parseInt(res.rows[0]?.n ?? "0", 10);
  } catch {
    return 0;
  }
}

/** Compliance actions still open (Financial Advisor). */
async function openCompliance(userId: string): Promise<number> {
  try {
    const res = await query<{ n: string }>(
      `SELECT COUNT(*) n FROM advisor_compliance_items
        WHERE user_id = $1 AND status <> 'done'`,
      [userId],
    );
    return parseInt(res.rows[0]?.n ?? "0", 10);
  } catch {
    return 0;
  }
}

/** Agent suggestions awaiting the user's approval. */
async function pendingApprovals(userId: string): Promise<number> {
  try {
    const res = await query<{ n: string }>(
      `SELECT COUNT(*) n FROM accountant_activity
        WHERE user_id = $1 AND status = 'suggested'`,
      [userId],
    );
    return parseInt(res.rows[0]?.n ?? "0", 10);
  } catch {
    return 0;
  }
}

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/** Assemble (but do not send) today's digest for one user. */
export async function buildDailyDigest(userId: string): Promise<DailyDigest> {
  const [events, overdue, leads, compliance, approvals] = await Promise.all([
    todaysEvents(userId),
    overdueInvoices(userId),
    activeLeads(userId),
    openCompliance(userId),
    pendingApprovals(userId),
  ]);

  const lines: DigestLine[] = [];
  if (events > 0) lines.push({ text: `${events} ${events === 1 ? "meeting" : "meetings"} today`, weight: 5 });
  if (approvals > 0) lines.push({ text: `${approvals} awaiting your approval`, weight: 4 });
  if (overdue.count > 0) {
    lines.push({ text: `${overdue.count} overdue ${overdue.count === 1 ? "invoice" : "invoices"} (${usd(overdue.cents)})`, weight: 4 });
  }
  if (compliance > 0) lines.push({ text: `${compliance} compliance ${compliance === 1 ? "item" : "items"} due`, weight: 3 });
  if (leads > 0) lines.push({ text: `${leads} ${leads === 1 ? "lead" : "leads"} to follow up`, weight: 2 });

  if (lines.length === 0) {
    return { userId, title: "", body: "", hasContent: false };
  }

  // Keep the body scannable on a lock screen: the 3 highest-signal clauses.
  const body = lines
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((l) => l.text)
    .join(" · ");

  return {
    userId,
    title: events > 0 ? "Your day at a glance" : "A few things need you",
    body,
    hasContent: true,
  };
}

/**
 * Build + deliver the digest for one user. Returns whether a push was actually sent.
 * The executionId/stepId pair makes delivery idempotent per user per day, so a QStash
 * retry can't double-notify.
 */
export async function sendDailyDigest(userId: string): Promise<boolean> {
  const digest = await buildDailyDigest(userId);
  if (!digest.hasContent) return false;

  const day = new Date().toISOString().slice(0, 10);
  await deliverNotification({
    executionId: `daily-digest:${day}`,
    stepId: userId,
    userId,
    title: digest.title,
    body: digest.body,
    actions: [],
  });
  return true;
}

/**
 * Global daily tick (hit by a QStash Schedule → /api/v1/workers/daily-digest).
 * Only considers users with a registered push token — without one there is nothing to
 * deliver to, and we'd just burn an email fallback on someone who never opted in.
 */
export async function runDailyDigestForAllUsers(): Promise<{ considered: number; sent: number }> {
  let considered = 0;
  let sent = 0;
  try {
    const res = await query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM push_tokens`,
    );
    considered = res.rows.length;
    for (const row of res.rows) {
      try {
        if (await sendDailyDigest(row.user_id)) sent += 1;
      } catch (err) {
        logger.warn("[daily-digest] failed for user", { userId: row.user_id, err: String(err) });
      }
    }
  } catch (err) {
    logger.warn("[daily-digest] tick failed", { err: String(err) });
  }
  logger.info("[daily-digest] tick complete", { considered, sent });
  return { considered, sent };
}
