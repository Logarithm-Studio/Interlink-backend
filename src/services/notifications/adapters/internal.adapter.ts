/**
 * Internal signals adapter — the hub's first and cheapest source.
 *
 * WHY THIS ONE FIRST: `dailyDigest.service.ts` already detects overdue invoices, cold leads,
 * pending approvals and due compliance, already weighted. It just collapses them into counts in
 * a sentence and throws the rows away. The hub needs the rows. Same queries, SELECT instead of
 * COUNT — no OAuth, no webhooks, no Composio quota, no new scope.
 *
 * It also means no focus persona (Product Manager, Finance, Real Estate) ships with an empty hub
 * on day one, which no external adapter could guarantee.
 *
 * DELIBERATELY NOT INCLUDED — today's meetings. The digest counts them, but the Events screen is
 * already a standing calendar queue with its own Yes/No prompts. Surfacing them here would put
 * the same item twice on one screen, which is the exact redundancy that keeps Calendar out of
 * the Events widget. The hub carries what happens TO your calendar (invites, reschedules,
 * cancellations, conflicts — see calendar.adapter.ts), not the calendar itself.
 *
 * Every item is `mode: 'professional'`: these all come from the Professional Work OS tables.
 * Personal-mode signal comes from Gmail and Calendar adapters.
 */

import { query } from "../../../config/db";
import { logger } from "../../../observability/logger";
import { upsertItem, setSourceHealth, HUB_WEIGHTS } from "../hub.service";
import { getRecentListingViews } from "../../professional/realestate/listingPhotos.service";

/** Money formatting matches the digest so the two surfaces read identically. */
const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/**
 * Refresh every internal signal for one user.
 *
 * Each block is independently guarded: a missing table or a persona the user does not use must
 * not stop the others. A half-populated hub is fine; a hub that throws is not.
 */
export async function runInternalAdapter(userId: string): Promise<number> {
  let written = 0;

  written += await safely("invoices", () => overdueInvoices(userId));
  written += await safely("approvals", () => pendingApprovals(userId));
  written += await safely("compliance", () => openCompliance(userId));
  written += await safely("leads", () => warmLeads(userId));
  written += await safely("showings", () => upcomingShowings(userId));
  written += await safely("leases", () => expiringLeases(userId));
  written += await safely("listingViews", () => listingInterest(userId));

  await setSourceHealth(userId, "internal", "ok");
  return written;
}

async function safely(label: string, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    logger.warn("[hub:internal] signal failed — skipping", {
      err: err instanceof Error ? err.message : String(err),
      signal: label,
    });
    return 0;
  }
}

// ─── Finance ─────────────────────────────────────────────────────────────────

/** Overdue receivables. Matches dailyDigest's `status IN ('overdue','reminded')`. */
async function overdueInvoices(userId: string): Promise<number> {
  const res = await query<{
    id: string;
    invoice_number: string;
    client_name: string;
    amount_cents: string;
    due_date: Date;
  }>(
    `SELECT id, invoice_number, client_name, amount_cents, due_date
       FROM invoices
      WHERE user_id = $1 AND status IN ('overdue', 'reminded')
      ORDER BY due_date ASC
      LIMIT 25`,
    [userId],
  );

  for (const row of res.rows) {
    const amount = usd(parseInt(row.amount_cents, 10));
    await upsertItem({
      userId,
      mode: "professional",
      source: "internal",
      kind: "invoice_overdue",
      dedupKey: `internal:invoice:${row.id}`,
      title: `${row.client_name} owes ${amount}`,
      preview: `Invoice ${row.invoice_number}, due ${formatDate(row.due_date)}.`,
      actor: row.client_name,
      weight: HUB_WEIGHTS.invoiceOverdue,
      externalRef: { invoiceId: row.id, route: `/(work)/invoice/${row.id}` },
      // NOT the literal "/(work)/invoice/[id]": that template string was stored verbatim,
      // so tapping the item pushed `[id]` as the id and the screen queried Postgres with
      // it — "invalid input syntax for type uuid". Substitute here, where the id is known.
      occurredAt: new Date(row.due_date),
    });
  }
  return res.rows.length;
}

/** Agent suggestions the user has not approved yet — the most literally "waiting on you" item. */
async function pendingApprovals(userId: string): Promise<number> {
  const res = await query<{
    id: string;
    title: string;
    detail: string | null;
    created_at: Date;
  }>(
    `SELECT id, title, detail, created_at
       FROM accountant_activity
      WHERE user_id = $1 AND status = 'suggested'
      ORDER BY created_at DESC
      LIMIT 25`,
    [userId],
  );

  for (const row of res.rows) {
    await upsertItem({
      userId,
      mode: "professional",
      source: "internal",
      kind: "approval_pending",
      dedupKey: `internal:approval:${row.id}`,
      title: row.title,
      preview: row.detail,
      actor: "Interlink",
      weight: HUB_WEIGHTS.approval,
      externalRef: { activityId: row.id, route: "/(work)/activity" },
      occurredAt: new Date(row.created_at),
    });
  }
  return res.rows.length;
}

/**
 * Compliance actions still open (Financial Advisor).
 *
 * Joined to `advisor_clients` because compliance titles are TEMPLATED per type — six clients
 * needing a beneficiary review produce six rows all titled "Confirm beneficiary designations".
 * Without the client name the feed looks broken (verified against live data, 2026-08-31).
 * The client is the thing that distinguishes them, so it belongs in the title.
 */
async function openCompliance(userId: string): Promise<number> {
  const res = await query<{
    id: string;
    title: string;
    type: string;
    due_date: Date | null;
    client_id: string | null;
    client_name: string | null;
  }>(
    `SELECT c.id, c.title, c.type, c.due_date, c.client_id, cl.name AS client_name
       FROM advisor_compliance_items c
       LEFT JOIN advisor_clients cl ON cl.id = c.client_id
      WHERE c.user_id = $1 AND c.status <> 'done'
      ORDER BY c.due_date NULLS LAST
      LIMIT 25`,
    [userId],
  );

  for (const row of res.rows) {
    await upsertItem({
      userId,
      mode: "professional",
      source: "internal",
      kind: "compliance_due",
      // SEMANTIC dedup key, not the row id. `advisor_compliance_items` contains duplicates —
      // /accountant/seed-demo re-inserts on every run, so one live account had 30 rows for 4
      // distinct items (verified 2026-08-31). Keying on identity rather than row id collapses
      // them into one notification instead of a wall of identical rows. An aggregator has to be
      // robust to messy upstream data; it cannot assume every source table is clean.
      dedupKey: `internal:compliance:${row.client_id ?? "none"}:${row.type}:${
        row.due_date ? new Date(row.due_date).toISOString().slice(0, 10) : "nodate"
      }`,
      title: row.client_name ? `${row.title} — ${row.client_name}` : row.title,
      preview: row.due_date ? `Due ${formatDate(row.due_date)}.` : "No due date set.",
      actor: row.client_name ?? "Compliance",
      weight: HUB_WEIGHTS.compliance,
      externalRef: { complianceId: row.id, route: "/(work)/advisor" },
      occurredAt: row.due_date ? new Date(row.due_date) : new Date(),
    });
  }
  return res.rows.length;
}

// ─── Real Estate ─────────────────────────────────────────────────────────────

/** Warm, unworked buyer leads. */
async function warmLeads(userId: string): Promise<number> {
  const res = await query<{
    id: string;
    name: string;
    interest: string | null;
    stage: string;
    updated_at: Date;
  }>(
    `SELECT id, name, interest, stage, updated_at
       FROM re_leads
      WHERE user_id = $1 AND stage IN ('new', 'qualified')
      ORDER BY updated_at ASC
      LIMIT 25`,
    [userId],
  );

  for (const row of res.rows) {
    await upsertItem({
      userId,
      mode: "professional",
      source: "internal",
      kind: "lead_followup",
      dedupKey: `internal:lead:${row.id}`,
      title: `Follow up with ${row.name}`,
      preview: row.interest ? `Interested in ${row.interest}.` : `Stage: ${row.stage}.`,
      actor: row.name,
      weight: HUB_WEIGHTS.lead,
      externalRef: { leadId: row.id, route: "/(work)/contacts" },
      occurredAt: new Date(row.updated_at),
    });
  }
  return res.rows.length;
}

/**
 * Showings in the next 48 hours. `re_showings` exists and no notification path has ever used it —
 * an unconfirmed showing tomorrow is exactly the "bad thing happens if you ignore it" case.
 */
async function upcomingShowings(userId: string): Promise<number> {
  const res = await query<{
    id: string;
    address: string;
    lead_name: string | null;
    scheduled_at: Date;
  }>(
    `SELECT id, address, lead_name, scheduled_at
       FROM re_showings
      WHERE user_id = $1
        AND scheduled_at IS NOT NULL
        AND scheduled_at >= now()
        AND scheduled_at <= now() + interval '48 hours'
      ORDER BY scheduled_at ASC
      LIMIT 25`,
    [userId],
  );

  for (const row of res.rows) {
    await upsertItem({
      userId,
      mode: "professional",
      source: "internal",
      kind: "showing_upcoming",
      dedupKey: `internal:showing:${row.id}`,
      title: `Showing at ${row.address}`,
      preview: row.lead_name
        ? `With ${row.lead_name}, ${formatDateTime(row.scheduled_at)}.`
        : formatDateTime(row.scheduled_at),
      actor: row.lead_name,
      weight: HUB_WEIGHTS.showing,
      externalRef: { showingId: row.id, route: "/(work)/listings" },
      occurredAt: new Date(row.scheduled_at),
    });
  }
  return res.rows.length;
}

/**
 * Leases ending within 45 days. Also previously unused by any notification path — and a renewal
 * you miss is a vacancy, which is the most expensive thing on this list.
 */
async function expiringLeases(userId: string): Promise<number> {
  const res = await query<{
    id: string;
    property: string;
    tenant_name: string | null;
    end_date: Date;
  }>(
    `SELECT id, property, tenant_name, end_date
       FROM re_leases
      WHERE user_id = $1
        AND end_date IS NOT NULL
        AND end_date >= CURRENT_DATE
        AND end_date <= CURRENT_DATE + interval '45 days'
      ORDER BY end_date ASC
      LIMIT 25`,
    [userId],
  );

  for (const row of res.rows) {
    await upsertItem({
      userId,
      mode: "professional",
      source: "internal",
      kind: "lease_expiring",
      dedupKey: `internal:lease:${row.id}`,
      title: `Lease ending — ${row.property}`,
      preview: row.tenant_name
        ? `${row.tenant_name}, ends ${formatDate(row.end_date)}.`
        : `Ends ${formatDate(row.end_date)}.`,
      actor: row.tenant_name,
      weight: HUB_WEIGHTS.leaseExpiring,
      externalRef: { leaseId: row.id, route: "/(work)/contracts" },
      occurredAt: new Date(row.end_date),
    });
  }
  return res.rows.length;
}


/**
 * Buyers looking at a listing.
 *
 * We host the public listing page, so this is a signal we own outright — no third party, no API
 * key, no Composio quota. Composio has no Zillow/AppFolio toolkit, which makes this the Real
 * Estate persona's only genuinely proprietary source.
 *
 * The bar: **repeat** interest only. One view is a click; several in three days is a buyer, and
 * a buyer looking without hearing from you is the thing that gets worse if ignored. A single
 * view would be activity, and the hub does not carry activity.
 */
async function listingInterest(userId: string): Promise<number> {
  const activity = await getRecentListingViews(userId, 3);
  const notable = activity.filter((a) => a.views >= 3);

  for (const row of notable) {
    await upsertItem({
      userId,
      mode: "professional",
      source: "internal",
      kind: "listing_interest",
      // Bucketed by day so sustained interest refreshes one row rather than stacking new ones,
      // but a fresh burst next week reads as a new signal.
      dedupKey: `internal:listing-views:${row.listingId}:${row.lastViewedAt
        .toISOString()
        .slice(0, 10)}`,
      title: `${row.views} views — ${row.address}`,
      preview: "Someone keeps coming back to this listing. Worth a follow-up.",
      actor: "Listing page",
      weight: HUB_WEIGHTS.lead,
      externalRef: { listingId: row.listingId, route: "/(work)/listings" },
      occurredAt: row.lastViewedAt,
    });
  }
  return notable.length;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(d: Date | string): string {
  return new Date(d).toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
