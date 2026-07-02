/**
 * Real Estate vertical (Professional Mode).
 * Listings + leads data model, demo seed, AI snapshot, and agentic tools.
 */

import { query } from "../../../config/db";
import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { sendProfessionalEmail } from "../email";
import { draftEmail } from "../draft";
import type { GeminiToolFunction } from "../../ai/geminiClient";
import type { AutomationProposal, PersonaVertical } from "../registry";

const PERSONA = "real_estate";

export type ListingStatus = "draft" | "active" | "pending" | "sold";
export type LeadStage = "new" | "qualified" | "touring" | "offer" | "closed" | "lost";

export interface Listing {
  id: string; address: string; priceCents: number; currency: string;
  beds: number | null; baths: number | null; sqft: number | null;
  status: ListingStatus; description: string | null; source: string; createdAt: Date;
}
export interface Lead {
  id: string; name: string; email: string | null; phone: string | null;
  budgetCents: number | null; interest: string | null; stage: LeadStage; source: string; createdAt: Date;
}

export async function listListings(userId: string): Promise<Listing[]> {
  const res = await query(
    `SELECT id, address, price_cents, currency, beds, baths, sqft, status, description, source, created_at
       FROM re_listings WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(mapListing as never);
}
export async function createListing(userId: string, data: { address: string; priceCents?: number; beds?: number; baths?: number; sqft?: number; status?: ListingStatus; description?: string; source?: string }): Promise<Listing> {
  const res = await query(
    `INSERT INTO re_listings (user_id, address, price_cents, beds, baths, sqft, status, description, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, address, price_cents, currency, beds, baths, sqft, status, description, source, created_at`,
    [userId, data.address, data.priceCents ?? 0, data.beds ?? null, data.baths ?? null, data.sqft ?? null, data.status ?? "active", data.description ?? null, data.source ?? "manual"]);
  return mapListing(res.rows[0] as never);
}
export async function listLeads(userId: string): Promise<Lead[]> {
  const res = await query(
    `SELECT id, name, email, phone, budget_cents, interest, stage, source, created_at
       FROM re_leads WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(mapLead as never);
}
export async function createLead(userId: string, data: { name: string; email?: string; phone?: string; budgetCents?: number; interest?: string; stage?: LeadStage; source?: string }): Promise<Lead> {
  const res = await query(
    `INSERT INTO re_leads (user_id, name, email, phone, budget_cents, interest, stage, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, name, email, phone, budget_cents, interest, stage, source, created_at`,
    [userId, data.name, data.email ?? null, data.phone ?? null, data.budgetCents ?? null, data.interest ?? null, data.stage ?? "new", data.source ?? "manual"]);
  return mapLead(res.rows[0] as never);
}
export async function updateLead(userId: string, id: string, patch: { stage?: LeadStage }): Promise<Lead | null> {
  const res = await query(
    `UPDATE re_leads SET stage = COALESCE($3, stage), updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING id, name, email, phone, budget_cents, interest, stage, source, created_at`,
    [id, userId, patch.stage ?? null]);
  return res.rows[0] ? mapLead(res.rows[0] as never) : null;
}

// ─── Showings + leases ─────────────────────────────────────────────────────
export interface Showing { id: string; address: string; leadName: string | null; scheduledAt: Date | null; notes: string | null; source: string; createdAt: Date }
export interface Lease { id: string; property: string; tenantName: string | null; tenantEmail: string | null; endDate: string | null; rentCents: number | null; source: string; createdAt: Date }

interface ShowingRow { id: string; address: string; lead_name: string | null; scheduled_at: Date | null; notes: string | null; source: string; created_at: Date }
interface LeaseRow { id: string; property: string; tenant_name: string | null; tenant_email: string | null; end_date: string | null; rent_cents: string | number | null; source: string; created_at: Date }
function mapShowing(x: ShowingRow): Showing {
  return { id: x.id, address: x.address, leadName: x.lead_name, scheduledAt: x.scheduled_at, notes: x.notes, source: x.source, createdAt: x.created_at };
}
function mapLease(x: LeaseRow): Lease {
  return { id: x.id, property: x.property, tenantName: x.tenant_name, tenantEmail: x.tenant_email, endDate: x.end_date, rentCents: x.rent_cents == null ? null : (typeof x.rent_cents === "string" ? parseInt(x.rent_cents, 10) : x.rent_cents), source: x.source, createdAt: x.created_at };
}

export async function listShowings(userId: string): Promise<Showing[]> {
  const res = await query<ShowingRow>(
    `SELECT id, address, lead_name, scheduled_at, notes, source, created_at
       FROM re_showings WHERE user_id = $1 ORDER BY scheduled_at DESC NULLS LAST, created_at DESC`, [userId]);
  return res.rows.map(mapShowing);
}
export async function createShowing(userId: string, data: { address: string; leadName?: string; scheduledAt?: string; notes?: string; source?: string }): Promise<Showing> {
  const res = await query<ShowingRow>(
    `INSERT INTO re_showings (user_id, address, lead_name, scheduled_at, notes, source)
     VALUES ($1,$2,$3, NULLIF($4,'')::timestamptz, $5, $6)
     RETURNING id, address, lead_name, scheduled_at, notes, source, created_at`,
    [userId, data.address, data.leadName ?? null, data.scheduledAt ?? "", data.notes ?? null, data.source ?? "manual"]);
  return mapShowing(res.rows[0]);
}
export async function listLeases(userId: string): Promise<Lease[]> {
  const res = await query<LeaseRow>(
    `SELECT id, property, tenant_name, tenant_email, end_date, rent_cents, source, created_at
       FROM re_leases WHERE user_id = $1 ORDER BY end_date ASC NULLS LAST`, [userId]);
  return res.rows.map(mapLease);
}
export async function createLease(userId: string, data: { property: string; tenantName?: string; tenantEmail?: string; endDate?: string; rentCents?: number; source?: string }): Promise<Lease> {
  const res = await query<LeaseRow>(
    `INSERT INTO re_leases (user_id, property, tenant_name, tenant_email, end_date, rent_cents, source)
     VALUES ($1,$2,$3,$4, NULLIF($5,'')::date, $6, $7)
     RETURNING id, property, tenant_name, tenant_email, end_date, rent_cents, source, created_at`,
    [userId, data.property, data.tenantName ?? null, data.tenantEmail ?? null, data.endDate ?? "", data.rentCents ?? null, data.source ?? "manual"]);
  return mapLease(res.rows[0]);
}

export async function seedDemo(userId: string): Promise<{ count: number }> {
  const existing = await query<{ n: string }>(`SELECT COUNT(*) n FROM re_listings WHERE user_id = $1`, [userId]);
  if (parseInt(existing.rows[0]?.n ?? "0", 10) > 0) return { count: 0 };
  const listings: { address: string; priceCents: number; beds: number; baths: number; sqft: number; status: ListingStatus }[] = [
    { address: "128 Maple Ave", priceCents: 42500000, beds: 3, baths: 2, sqft: 1850, status: "active" },
    { address: "9 Lakeview Ct", priceCents: 78900000, beds: 4, baths: 3, sqft: 2900, status: "pending" },
    { address: "540 Birch St #12", priceCents: 31000000, beds: 2, baths: 1, sqft: 1100, status: "active" },
  ];
  for (const l of listings) await createListing(userId, { ...l, source: "demo" });
  const leads: { name: string; email: string; budgetCents: number; interest: string; stage: LeadStage }[] = [
    { name: "Nora Adams", email: "nora@example.com", budgetCents: 45000000, interest: "3bd near downtown", stage: "qualified" },
    { name: "Victor Ruiz", email: "victor@example.com", budgetCents: 80000000, interest: "lakefront", stage: "touring" },
    { name: "Emma Cole", email: "emma@example.com", budgetCents: 33000000, interest: "starter condo", stage: "new" },
  ];
  for (const ld of leads) await createLead(userId, { ...ld, source: "demo" });

  await createShowing(userId, { address: "128 Maple Ave", leadName: "Nora Adams", scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(), source: "demo" });
  const soon = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  await createLease(userId, { property: "540 Birch St #12", tenantName: "Owen Diaz", tenantEmail: "owen@example.com", endDate: soon, rentCents: 210000, source: "demo" });

  return { count: listings.length + leads.length };
}

async function buildSnapshot(userId: string): Promise<string> {
  const [listings, leads] = await Promise.all([listListings(userId), listLeads(userId)]);
  const active = listings.filter((l) => l.status === "active" || l.status === "pending");
  const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US")}`;
  return [
    `Active listings: ${active.length}. Leads: ${leads.length}.`,
    "Listings:",
    ...listings.slice(0, 15).map((l) => `- ${l.address} | ${fmt(l.priceCents)} | ${l.beds ?? "?"}bd/${l.baths ?? "?"}ba | ${l.status}`),
    "Leads:",
    ...leads.slice(0, 15).map((l) => `- ${l.name} | ${l.email ?? "no-email"} | budget ${l.budgetCents ? fmt(l.budgetCents) : "?"} | ${l.interest ?? ""} | ${l.stage}`),
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are the user's AI real-estate assistant inside the Interlink app.",
  "Answer questions about listings/leads using ONLY the DATA SNAPSHOT, or perform ONE action by calling a function when asked.",
  "Never invent properties or leads. You never send anything yourself — the app confirms before executing.",
].join("\n");

const TOOLS: GeminiToolFunction[] = [
  { name: "create_listing", description: "Add a new property listing.", parameters: { type: "object", properties: { address: { type: "string" }, priceCents: { type: "number" }, beds: { type: "number" }, baths: { type: "number" } }, required: ["address"] } },
  { name: "draft_listing_description", description: "Write a marketing description for a listing (returns copy, does not publish).", parameters: { type: "object", properties: { address: { type: "string" } }, required: ["address"] } },
  { name: "qualify_lead", description: "Move a buyer lead to a new stage.", parameters: { type: "object", properties: { name: { type: "string" }, stage: { type: "string", enum: ["new", "qualified", "touring", "offer", "closed", "lost"] } }, required: ["name", "stage"] } },
  { name: "follow_up_lead", description: "Draft and send a follow-up email to a buyer lead.", parameters: { type: "object", properties: { name: { type: "string" }, note: { type: "string" } }, required: ["name"] } },
  { name: "schedule_showing", description: "Record a property showing for a lead.", parameters: { type: "object", properties: { address: { type: "string" }, leadName: { type: "string" }, when: { type: "string", description: "ISO datetime." } }, required: ["address"] } },
  { name: "lease_renewal", description: "Draft and send a lease-renewal email to a tenant.", parameters: { type: "object", properties: { property: { type: "string", description: "Property from the snapshot." } }, required: ["property"] } },
];

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "create_listing": return `Add listing ${args.address ?? ""}.`;
    case "draft_listing_description": return `Draft a description for ${args.address ?? "the listing"}.`;
    case "qualify_lead": return `Move lead ${args.name ?? ""} to ${args.stage}.`;
    case "follow_up_lead": return `Draft & send a follow-up to ${args.name ?? "the lead"}.`;
    case "schedule_showing": return `Record a showing at ${args.address ?? "the property"}.`;
    case "lease_renewal": return `Draft & send a renewal for ${args.property ?? "the lease"}.`;
    default: return `Run ${name}.`;
  }
}

async function executeTool(user: AppUser, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    switch (name) {
      case "create_listing": {
        const l = await createListing(user.id, { address: String(args.address ?? "").trim(), priceCents: typeof args.priceCents === "number" ? args.priceCents : undefined, beds: typeof args.beds === "number" ? args.beds : undefined, baths: typeof args.baths === "number" ? args.baths : undefined, source: "assistant" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "listing_created", title: `Added listing ${l.address}`, entityType: "re_listing", entityId: l.id });
        return { ok: true, message: `Added listing ${l.address}.` };
      }
      case "draft_listing_description": {
        const listings = await listListings(user.id);
        const l = listings.find((x) => x.address.toLowerCase().includes(String(args.address ?? "").toLowerCase()));
        if (!l) return { ok: false, message: "Couldn't find that listing." };
        const draft = await draftEmail({ role: "real-estate marketer", purpose: "an appealing MLS-style property description (use the body field for the description)", context: `Property: ${l.address}, ${l.beds ?? "?"}bd/${l.baths ?? "?"}ba, ${l.sqft ?? "?"} sqft, priced ${(l.priceCents / 100).toLocaleString("en-US")}.` });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "listing_described", title: `Drafted description for ${l.address}`, entityType: "re_listing", entityId: l.id });
        return { ok: true, message: draft.body };
      }
      case "qualify_lead": {
        const leads = await listLeads(user.id);
        const ld = leads.find((x) => x.name.toLowerCase() === String(args.name ?? "").toLowerCase());
        if (!ld) return { ok: false, message: "Couldn't find that lead." };
        await updateLead(user.id, ld.id, { stage: args.stage as LeadStage });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "lead_qualified", title: `${ld.name} → ${args.stage}`, entityType: "re_lead", entityId: ld.id });
        return { ok: true, message: `Moved ${ld.name} to ${args.stage}.` };
      }
      case "follow_up_lead": {
        const leads = await listLeads(user.id);
        const ld = leads.find((x) => x.name.toLowerCase() === String(args.name ?? "").toLowerCase());
        if (!ld) return { ok: false, message: "Couldn't find that lead." };
        if (!ld.email) return { ok: false, message: `No email on file for ${ld.name}.` };
        const draft = await draftEmail({ role: "real-estate agent", purpose: "a warm follow-up to a buyer lead", context: `Lead: ${ld.name}, interested in ${ld.interest ?? "a home"}, budget ${ld.budgetCents ? `$${(ld.budgetCents / 100).toLocaleString("en-US")}` : "unknown"}. ${args.note ? `Note: ${args.note}` : ""}` });
        await sendProfessionalEmail({ user, to: ld.email, subject: draft.subject, body: draft.body, tag: "re_followup" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "lead_followup", title: `Follow-up sent to ${ld.name}`, detail: draft.subject, entityType: "re_lead", entityId: ld.id });
        return { ok: true, message: `Follow-up sent to ${ld.name}.` };
      }
      case "schedule_showing": {
        const s = await createShowing(user.id, { address: String(args.address ?? "").trim(), leadName: args.leadName ? String(args.leadName) : undefined, scheduledAt: args.when ? String(args.when) : undefined, source: "assistant" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "showing_scheduled", title: `Showing at ${s.address}`, entityType: "re_showing", entityId: s.id });
        return { ok: true, message: `Showing recorded for ${s.address}.` };
      }
      case "lease_renewal": {
        const leases = await listLeases(user.id);
        const l = leases.find((x) => x.property.toLowerCase().includes(String(args.property ?? "").toLowerCase()));
        if (!l) return { ok: false, message: "Couldn't find that lease." };
        if (!l.tenantEmail) return { ok: false, message: `No tenant email on file for ${l.property}.` };
        const draft = await draftEmail({ role: "property manager", purpose: "a friendly lease-renewal offer", context: `Property: ${l.property}. Tenant: ${l.tenantName ?? ""}. Lease ends ${l.endDate ?? "soon"}. Current rent ${l.rentCents ? `$${(l.rentCents / 100).toLocaleString("en-US")}/mo` : "unknown"}.` });
        await sendProfessionalEmail({ user, to: l.tenantEmail, subject: draft.subject, body: draft.body, tag: "re_lease_renewal" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "lease_renewal_sent", title: `Renewal sent for ${l.property}`, detail: draft.subject, entityType: "re_lease", entityId: l.id });
        return { ok: true, message: `Renewal sent to ${l.tenantName ?? "tenant"}.` };
      }
      default:
        return { ok: false, message: `Unsupported action: ${name}.` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function mapListing(r: { id: string; address: string; price_cents: string | number; currency: string; beds: number | null; baths: number | null; sqft: number | null; status: ListingStatus; description: string | null; source: string; created_at: Date }): Listing {
  return { id: r.id, address: r.address, priceCents: typeof r.price_cents === "string" ? parseInt(r.price_cents, 10) : r.price_cents, currency: r.currency, beds: r.beds, baths: r.baths, sqft: r.sqft, status: r.status, description: r.description, source: r.source, createdAt: r.created_at };
}
function mapLead(r: { id: string; name: string; email: string | null; phone: string | null; budget_cents: string | number | null; interest: string | null; stage: LeadStage; source: string; created_at: Date }): Lead {
  return { id: r.id, name: r.name, email: r.email, phone: r.phone, budgetCents: r.budget_cents == null ? null : (typeof r.budget_cents === "string" ? parseInt(r.budget_cents, 10) : r.budget_cents), interest: r.interest, stage: r.stage, source: r.source, createdAt: r.created_at };
}

async function planNewLeadFollowup(userId: string): Promise<AutomationProposal[]> {
  const res = await query<{ id: string; name: string }>(
    `SELECT id, name FROM re_leads
      WHERE user_id = $1 AND stage IN ('new','qualified')
        AND email IS NOT NULL AND email <> ''
      ORDER BY created_at ASC LIMIT 10`,
    [userId],
  );
  return res.rows.map((l) => ({
    title: `Follow up with ${l.name}`,
    entityType: "re_lead",
    entityId: l.id,
    tool: "follow_up_lead",
    args: { name: l.name },
  }));
}

async function planLeaseRenewals(userId: string): Promise<AutomationProposal[]> {
  const res = await query<{ id: string; property: string }>(
    `SELECT id, property FROM re_leases
      WHERE user_id = $1 AND tenant_email IS NOT NULL AND tenant_email <> ''
        AND end_date IS NOT NULL AND end_date <= CURRENT_DATE + INTERVAL '60 days'
        AND end_date >= CURRENT_DATE
      ORDER BY end_date ASC LIMIT 10`,
    [userId],
  );
  return res.rows.map((l) => ({
    title: `Offer renewal for ${l.property}`,
    entityType: "re_lease",
    entityId: l.id,
    tool: "lease_renewal",
    args: { property: l.property },
  }));
}

export const realEstateVertical: PersonaVertical = {
  persona: PERSONA,
  tools: TOOLS,
  systemPrompt: SYSTEM_PROMPT,
  buildSnapshot,
  executeTool,
  summarizeAction,
  seedDemo,
  automations: [
    {
      type: "new_lead_followup",
      title: "New-lead follow-ups",
      description: "Reach out to fresh buyer leads before they go cold",
      cadenceDays: 2,
      defaultAutonomy: "suggest",
      plan: planNewLeadFollowup,
    },
    {
      type: "lease_renewal_reminder",
      title: "Lease-renewal reminders",
      description: "Offer renewals to tenants whose lease ends within 60 days",
      cadenceDays: 7,
      defaultAutonomy: "suggest",
      plan: planLeaseRenewals,
    },
  ],
};
