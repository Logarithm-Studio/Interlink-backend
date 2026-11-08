/**
 * Real Estate vertical (Professional Mode).
 * Listings + leads data model, demo seed, AI snapshot, and agentic tools.
 */

import { query } from "../../../config/db";
import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { resolveNamedRecord } from "../assistant-records.service";
import { AppError } from "../../../utils/errors";
import { draftEmail } from "../draft";
import type { GeminiToolFunction } from "../../ai/geminiClient";
import type { AutomationProposal, PersonaVertical } from "../registry";
import { getMarketStats, isRentCastConfigured, searchListings, type MarketListing } from "./rentcast.service";
import { getCensusMarketStats, isCensusConfigured } from "./census.service";
import { searchRapidListings, isRapidListingsConfigured } from "./rapidListings.service";
import { searchSimplyRets, isSimplyRetsLive } from "./simplyrets.service";
import { publishListing, shareUrl as listingShareUrl } from "./listingPhotos.service";

const PERSONA = "real_estate";

const usd = (cents: number): string => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/** Pull a bedroom count out of free-text interest ("3bd near downtown" → 3). */
function bedsFromInterest(interest: string | null): number | null {
  const m = (interest ?? "").match(/(\d+)\s*(?:bd|bed|bedroom)/i);
  return m ? Number(m[1]) : null;
}

export type ListingStatus = "draft" | "active" | "pending" | "sold";
export type LeadStage = "new" | "qualified" | "touring" | "offer" | "closed" | "lost";

export interface Listing {
  id: string; address: string; priceCents: number; currency: string;
  beds: number | null; baths: number | null; sqft: number | null;
  status: ListingStatus; description: string | null; source: string; createdAt: Date;
  /** Public Supabase Storage URLs; first is the cover. */
  photos: string[];
  /** Set once the listing has a public share page (see listingPhotos.service.ts). */
  shareSlug: string | null;
}
export interface Lead {
  id: string; name: string; email: string | null; phone: string | null;
  budgetCents: number | null; interest: string | null; stage: LeadStage; source: string; createdAt: Date;
}

export async function listListings(userId: string): Promise<Listing[]> {
  const res = await query(
    `SELECT id, address, price_cents, currency, beds, baths, sqft, status, description, source, created_at, photos, share_slug
       FROM re_listings WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(mapListing as never);
}
export async function createListing(userId: string, data: { address: string; priceCents?: number; beds?: number; baths?: number; sqft?: number; status?: ListingStatus; description?: string; source?: string }): Promise<Listing> {
  if (!data.address.trim() || (data.priceCents !== undefined && (!Number.isSafeInteger(data.priceCents) || data.priceCents < 0)) || [data.beds, data.baths, data.sqft].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))) throw new AppError("Provide an address and valid nonnegative property amounts/dimensions.", 400);
  const res = await query(
    `INSERT INTO re_listings (user_id, address, price_cents, beds, baths, sqft, status, description, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, address, price_cents, currency, beds, baths, sqft, status, description, source, created_at, photos, share_slug`,
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
  if (!data.name.trim() || (data.budgetCents !== undefined && (!Number.isSafeInteger(data.budgetCents) || data.budgetCents < 0))) throw new AppError("Provide a buyer name and a valid nonnegative budget in USD minor units.", 400);
  const res = await query(
    `INSERT INTO re_leads (user_id, name, email, phone, budget_cents, interest, stage, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, name, email, phone, budget_cents, interest, stage, source, created_at`,
    [userId, data.name, data.email ?? null, data.phone ?? null, data.budgetCents ?? null, data.interest ?? null, data.stage ?? "new", data.source ?? "manual"]);
  return mapLead(res.rows[0] as never);
}
export async function updateLead(userId: string, id: string, patch: { stage?: LeadStage; expectedStage?: LeadStage }): Promise<Lead | null> {
  const res = await query(
    `UPDATE re_leads SET stage = COALESCE($3, stage), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND ($4::text IS NULL OR stage=$4)
      RETURNING id, name, email, phone, budget_cents, interest, stage, source, created_at`,
    [id, userId, patch.stage ?? null, patch.expectedStage ?? null]);
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

/**
 * Load a rich, curated Real-Estate demo book. **Reset-and-reseed**: wipes this user's existing
 * listings/leads/showings/leases first, then inserts a full dataset whose budgets + interests are
 * deliberately arranged so `match_buyers` produces strong, varied buyer↔listing shortlists (every
 * buyer matches at least one listing). Idempotent — tap "Load demo" any time for a clean book.
 */
export async function seedDemo(userId: string): Promise<{ count: number; listings: number; leads: number }> {
  // Reset (the user explicitly asked to load a clean demo book).
  await query(`DELETE FROM re_showings WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM re_leases   WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM re_leads    WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM re_listings WHERE user_id = $1`, [userId]);

  // Inventory — varied price / beds / baths, realistic addresses, a mix of active & pending.
  const listings: { address: string; priceCents: number; beds: number; baths: number; sqft: number; status: ListingStatus }[] = [
    { address: "128 Maple Ave", priceCents: 42500000, beds: 3, baths: 2, sqft: 1850, status: "active" },
    { address: "9 Lakeview Ct", priceCents: 78900000, beds: 4, baths: 3, sqft: 2900, status: "pending" },
    { address: "540 Birch St #12", priceCents: 31000000, beds: 2, baths: 1, sqft: 1100, status: "active" },
    { address: "77 Oakmont Dr", priceCents: 52500000, beds: 4, baths: 3, sqft: 2400, status: "active" },
    { address: "210 Cedar Ln", priceCents: 99900000, beds: 5, baths: 4, sqft: 3800, status: "active" },
    { address: "34 Willow Way", priceCents: 36500000, beds: 3, baths: 2, sqft: 1600, status: "active" },
    { address: "1450 Sunset Blvd #8", priceCents: 27500000, beds: 2, baths: 2, sqft: 1200, status: "active" },
    { address: "88 Highland Park", priceCents: 67500000, beds: 4, baths: 3, sqft: 2700, status: "pending" },
    { address: "5 Riverside Ter", priceCents: 125000000, beds: 5, baths: 5, sqft: 4500, status: "active" },
    { address: "302 Elm St", priceCents: 45000000, beds: 3, baths: 2, sqft: 1900, status: "active" },
    { address: "19 Meadowbrook Rd", priceCents: 58500000, beds: 4, baths: 3, sqft: 2500, status: "active" },
    { address: "640 Park Ave #3", priceCents: 34000000, beds: 2, baths: 2, sqft: 1300, status: "active" },
  ];
  for (const l of listings) await createListing(userId, { ...l, source: "demo" });

  // Buyer leads — budgets bracket the inventory and each interest names a bedroom count
  // (parsed by bedsFromInterest), so match_buyers returns a real shortlist for everyone.
  const leads: { name: string; email: string; phone: string; budgetCents: number; interest: string; stage: LeadStage }[] = [
    { name: "Nora Adams", email: "nora@example.com", phone: "+1 512 555 0110", budgetCents: 45000000, interest: "3bd near downtown, walkable", stage: "qualified" },
    { name: "Victor Ruiz", email: "victor@example.com", phone: "+1 512 555 0111", budgetCents: 85000000, interest: "4 bedroom lakefront with a view", stage: "touring" },
    { name: "Emma Cole", email: "emma@example.com", phone: "+1 512 555 0112", budgetCents: 32000000, interest: "2bd starter condo, low maintenance", stage: "new" },
    { name: "Liam Patel", email: "liam@example.com", phone: "+1 512 555 0113", budgetCents: 130000000, interest: "5 bedroom luxury home, home office", stage: "qualified" },
    { name: "Sophia Nguyen", email: "sophia@example.com", phone: "+1 512 555 0114", budgetCents: 60000000, interest: "4bd family home, good schools", stage: "touring" },
    { name: "Marcus Bell", email: "marcus@example.com", phone: "+1 512 555 0115", budgetCents: 50000000, interest: "3bd with a yard for the dog", stage: "new" },
    { name: "Olivia Grant", email: "olivia@example.com", phone: "+1 512 555 0116", budgetCents: 30000000, interest: "2 bedroom near transit", stage: "qualified" },
    { name: "Ethan Brooks", email: "ethan@example.com", phone: "+1 512 555 0117", budgetCents: 70000000, interest: "4bd modern, open floor plan", stage: "touring" },
    { name: "Ava Morales", email: "ava@example.com", phone: "+1 512 555 0118", budgetCents: 40000000, interest: "3bd, fixer-upper is fine", stage: "new" },
    { name: "Noah Kim", email: "noah@example.com", phone: "+1 512 555 0119", budgetCents: 100000000, interest: "5bd with a pool", stage: "qualified" },
  ];
  for (const ld of leads) await createLead(userId, { ...ld, source: "demo" });

  // A few upcoming showings + two active leases (one expiring soon → drives lease-renewal).
  const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString();
  await createShowing(userId, { address: "128 Maple Ave", leadName: "Nora Adams", scheduledAt: inDays(2), source: "demo" });
  await createShowing(userId, { address: "9 Lakeview Ct", leadName: "Victor Ruiz", scheduledAt: inDays(3), source: "demo" });
  await createShowing(userId, { address: "77 Oakmont Dr", leadName: "Sophia Nguyen", scheduledAt: inDays(5), source: "demo" });

  const dateInDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  await createLease(userId, { property: "540 Birch St #12", tenantName: "Owen Diaz", tenantEmail: "owen@example.com", endDate: dateInDays(45), rentCents: 210000, source: "demo" });
  await createLease(userId, { property: "640 Park Ave #3", tenantName: "Mia Chen", tenantEmail: "mia@example.com", endDate: dateInDays(30), rentCents: 185000, source: "demo" });

  return { count: listings.length + leads.length, listings: listings.length, leads: leads.length };
}

async function buildSnapshot(userId: string): Promise<string> {
  const [listings, leads] = await Promise.all([listListings(userId), listLeads(userId)]);
  const active = listings.filter((l) => l.status === "active" || l.status === "pending");
  const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US")}`;
  return [
    `Active listings: ${active.length}. Leads: ${leads.length}.`,
    isRentCastConfigured() || isRapidListingsConfigured() || isSimplyRetsLive()
      ? "Live listings are connected: use search_market for real for-sale listings by area, and market_report for area stats by ZIP."
      : `search_market has demonstration MLS data only — Houston, TX metro. These are not verified live listings; set RENTCAST_API_KEY or RAPIDAPI_KEY for live data. market_report gives area stats by ZIP${
          isCensusConfigured() ? " via US Census (free)." : " — set CENSUS_API_KEY (free) to enable it."
        }`,
    "Listings:",
    ...listings.slice(0, 15).map((l) => `- ${l.address} | id=${l.id} | ${l.currency} ${(l.priceCents / 100).toLocaleString("en-US")} | ${l.beds ?? "?"}bd/${l.baths ?? "?"}ba | ${l.status}`),
    "Leads:",
    ...leads.slice(0, 15).map((l) => `- ${l.name} | id=${l.id} | ${l.email ?? "no-email"} | budget ${l.budgetCents ? fmt(l.budgetCents) : "?"} | ${l.interest ?? ""} | ${l.stage}`),
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are the user's AI real-estate assistant inside the Interlink app.",
  "Answer questions about listings/leads using ONLY the DATA SNAPSHOT, or perform ONE action by calling a function when asked.",
  "You can match buyer leads to the agent's listings (match_buyers), search live for-sale inventory",
  "(search_market — needs a city/state or ZIP), and produce an area market report by ZIP (market_report).",
  "Never invent properties or leads. You never send anything yourself — the app confirms before executing.",
].join("\n");

const TOOLS: GeminiToolFunction[] = [
  { name: "create_buyer_lead", description: "Save a local buyer lead from supplied details. Stored buyer budgets are USD minor units; do not infer a currency conversion. Does not send outreach.", parameters: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, budgetCents: { type: "integer" }, interest: { type: "string" } }, required: ["name"] } },
  { name: "create_listing", description: "Add a new property listing.", parameters: { type: "object", properties: { address: { type: "string" }, priceCents: { type: "number" }, beds: { type: "number" }, baths: { type: "number" } }, required: ["address"] } },
  { name: "draft_listing_description", description: "Write a marketing description for a listing (returns copy, does not publish).", parameters: { type: "object", properties: { address: { type: "string" } }, required: ["address"] } },
  { name: "qualify_lead", description: "Move a buyer lead to a new stage.", parameters: { type: "object", properties: { name: { type: "string" }, stage: { type: "string", enum: ["new", "qualified", "touring", "offer", "closed", "lost"] } }, required: ["name", "stage"] } },
  { name: "follow_up_lead", description: "Draft and send a follow-up email to a buyer lead.", parameters: { type: "object", properties: { name: { type: "string" }, note: { type: "string" } }, required: ["name"] } },
  { name: "schedule_showing", description: "Record a property showing for a lead.", parameters: { type: "object", properties: { address: { type: "string" }, leadName: { type: "string" }, when: { type: "string", description: "ISO datetime." } }, required: ["address"] } },
  { name: "lease_renewal", description: "Draft and send a lease-renewal email to a tenant. Optionally pass the property's ZIP to factor localized market pricing trends into the renewal terms.", parameters: { type: "object", properties: { property: { type: "string", description: "Property from the snapshot." }, zipCode: { type: "string", description: "Property ZIP — pulls localized pricing trends (RentCast) to inform the renewal." } }, required: ["property"] } },
  { name: "match_buyers", description: "Match buyer leads to the agent's active listings by budget and bedrooms (from each lead's interest). Returns a shortlist per buyer.", parameters: { type: "object", properties: { name: { type: "string", description: "Optional: match a single lead by name; otherwise matches all active buyer leads." } } } },
  { name: "send_listing_to_buyer", description: "Email one of the agent's own listings to a buyer lead, including a link to the listing's public page (with photos). Publishes the page automatically if it isn't public yet. Use after match_buyers to actually put the property in front of the buyer.", parameters: { type: "object", properties: { name: { type: "string", description: "Buyer lead name from the snapshot." }, address: { type: "string", description: "Address of the agent's listing to send." }, note: { type: "string", description: "Optional personal line to include." } }, required: ["name", "address"] } },
  { name: "search_market", description: "Search LIVE for-sale market listings (real current listings from Realtor.com/RentCast). Provide a city+state or a ZIP code; optionally filter by beds and max price. Returns real properties on the market with address, price, beds/baths, and size.", parameters: { type: "object", properties: { city: { type: "string" }, state: { type: "string", description: "2-letter state code, e.g. TX." }, zipCode: { type: "string" }, beds: { type: "number", description: "Minimum bedrooms." }, maxPrice: { type: "number", description: "Max price in dollars." } } } },
  { name: "market_report", description: "Generate an area market report for a ZIP code — median home value, median rent, and owner-occupancy from free US Census data (or live sale stats if RentCast is configured).", parameters: { type: "object", properties: { zipCode: { type: "string", description: "The ZIP code to report on." } }, required: ["zipCode"] } },
  { name: "transaction_tasks", description: "Produce a standard purchase/closing task checklist for a property that's gone under contract, with milestone due dates counted back from the close date. Use when a deal is accepted and the agent needs to manage the transaction to closing.", parameters: { type: "object", properties: { property: { type: "string", description: "The property address or listing under contract." }, closeDate: { type: "string", description: "Target closing date (YYYY-MM-DD). Defaults to 30 days out." } }, required: ["property"] } },
];

for (const tool of TOOLS) {
  const properties = tool.parameters.properties as Record<string, unknown>;
  if (["draft_listing_description", "send_listing_to_buyer"].includes(tool.name)) properties.listingId = { type: "string", description: "Exact owned listing ID; preferred over matching an address." };
  if (["qualify_lead", "follow_up_lead", "send_listing_to_buyer", "match_buyers"].includes(tool.name)) properties.leadId = { type: "string", description: "Exact owned buyer lead ID." };
  if (tool.name === "lease_renewal") properties.leaseId = { type: "string", description: "Exact owned lease ID." };
  if (["draft_listing_description", "qualify_lead", "follow_up_lead", "lease_renewal", "send_listing_to_buyer"].includes(tool.name)) tool.parameters.required = ((tool.parameters.required ?? []) as string[]).filter(key => !["name", "address", "property"].includes(key));
  if (["follow_up_lead", "lease_renewal", "send_listing_to_buyer"].includes(tool.name)) tool.description = "Prepare exact recipient, subject and body for the selected owned record. Does not send or publish. Use a separate send_gmail review for requested delivery. Listing copy requires an already public page; publish_listing is separately reviewed.";
  if (tool.name === "search_market") tool.description = "Read for-sale inventory for city/state or ZIP, labelled by actual source. Without live credentials, the feed is demonstration data only; never present demo inventory as current verified listings.";
  if (tool.name === "transaction_tasks") {
    tool.parameters.required = ["property", "closeDate"];
    properties.closeDate = { type: "string", description: "The actual agreed future closing date, YYYY-MM-DD. Never invent it." };
  }
}
TOOLS.push({ name: "publish_listing", description: "Publish an exact owned listing as a public web page. This is a separate reviewed publication; it never emails anyone.", parameters: { type: "object", properties: { listingId: { type: "string" }, address: { type: "string" } } } });

async function reviewRealEstateAction(userId: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let result = args;
  if (["qualify_lead", "follow_up_lead", "send_listing_to_buyer"].includes(name)) {
    const lead = resolveNamedRecord(await listLeads(userId), "name", args.leadId, args.name);
    result = { ...result, leadId: lead.id, name: lead.name, reviewedStage: lead.stage };
  }
  if (["draft_listing_description", "publish_listing", "send_listing_to_buyer"].includes(name)) {
    const listing = resolveNamedRecord(await listListings(userId), "address", args.listingId, args.address);
    result = { ...result, listingId: listing.id, address: listing.address };
  }
  if (name === "lease_renewal") {
    const lease = resolveNamedRecord(await listLeases(userId), "property", args.leaseId, args.property);
    result = { ...result, leaseId: lease.id, property: lease.property };
  }
  return result;
}

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "create_buyer_lead": return `Save buyer lead ${args.name ?? ""}. No outreach will be sent.`;
    case "create_listing": return `Add listing ${args.address ?? ""}.`;
    case "draft_listing_description": return `Draft a description for ${args.address ?? "the listing"}.`;
    case "qualify_lead": return `Move lead ${args.name ?? ""} to ${args.stage}.`;
    case "follow_up_lead": return `Prepare follow-up copy for ${args.name ?? "the lead"}. No email will be sent.`;
    case "schedule_showing": return `Record a showing at ${args.address ?? "the property"}.`;
    case "lease_renewal": return `Prepare renewal copy for ${args.property ?? "the lease"}. No email will be sent.`;
    case "match_buyers": return args.name ? `Match ${args.name} to your listings.` : "Match your buyer leads to your listings.";
    case "send_listing_to_buyer": return `Prepare listing copy for ${args.name ?? "the buyer"}. No email or publication.`;
    case "publish_listing": return `Publish ${args.address ?? "the selected listing"} as a public web page.`;
    case "search_market": return `Search the market${args.zipCode ? ` in ${args.zipCode}` : args.city ? ` in ${args.city}${args.state ? `, ${args.state}` : ""}` : ""}.`;
    case "market_report": return `Generate a market report for ${args.zipCode ?? "the area"}.`;
    case "transaction_tasks": return `Build a closing checklist for ${args.property ?? "the property"}.`;
    default: return `Run ${name}.`;
  }
}

async function executeTool(user: AppUser, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string; data?: unknown }> {
  try {
    switch (name) {
      case "create_buyer_lead": {
        const lead = await createLead(user.id, { name: String(args.name ?? "").trim(), email: args.email ? String(args.email) : undefined, phone: args.phone ? String(args.phone) : undefined, budgetCents: args.budgetCents as number | undefined, interest: args.interest ? String(args.interest) : undefined, source: "assistant" });
        return { ok: true, message: `Created buyer lead ${lead.name}. No outreach was sent.`, data: lead };
      }
      case "publish_listing": {
        const listing = resolveNamedRecord(await listListings(user.id), "address", args.listingId, args.address);
        const published = await publishListing(user.id, listing.id);
        return { ok: true, message: `Published the listing page: ${published.shareUrl}. No email was sent.`, data: { listingId: listing.id, ...published } };
      }
      case "create_listing": {
        const l = await createListing(user.id, { address: String(args.address ?? "").trim(), priceCents: typeof args.priceCents === "number" ? args.priceCents : undefined, beds: typeof args.beds === "number" ? args.beds : undefined, baths: typeof args.baths === "number" ? args.baths : undefined, source: "assistant" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "listing_created", title: `Added listing ${l.address}`, entityType: "re_listing", entityId: l.id });
        return { ok: true, message: `Added listing ${l.address}.`, data: l };
      }
      case "draft_listing_description": {
        const l = resolveNamedRecord(await listListings(user.id), "address", args.listingId, args.address);
        const draft = await draftEmail({ role: "real-estate marketer", purpose: "an appealing MLS-style property description (use the body field for the description)", context: `Property: ${l.address}, ${l.beds ?? "?"}bd/${l.baths ?? "?"}ba, ${l.sqft ?? "?"} sqft, priced ${(l.priceCents / 100).toLocaleString("en-US")}.` });
        if (draft.isFallback || !draft.body.trim()) return { ok: false, message: "Listing copy is unavailable. Nothing was saved or published." };
        return { ok: true, message: draft.body, data: { listingId: l.id, body: draft.body, status: "draft" } };
      }
      case "qualify_lead": {
        const ld = resolveNamedRecord(await listLeads(user.id), "name", args.leadId, args.name);
        if (!["new", "qualified", "touring", "offer", "closed", "lost"].includes(String(args.stage))) throw new AppError("Choose a supported buyer stage.", 400);
        if (args.reviewedStage && ld.stage !== args.reviewedStage) throw new AppError("This lead changed after review. Prepare a fresh review.", 409);
        if (!await updateLead(user.id, ld.id, { stage: args.stage as LeadStage, expectedStage: ld.stage })) throw new AppError("This lead changed after review. Prepare a fresh review.", 409);
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "lead_qualified", title: `${ld.name} → ${args.stage}`, entityType: "re_lead", entityId: ld.id });
        return { ok: true, message: `Moved ${ld.name} to ${args.stage}.` };
      }
      case "follow_up_lead": {
        const ld = resolveNamedRecord(await listLeads(user.id), "name", args.leadId, args.name);
        if (!ld.email) return { ok: false, message: `No email on file for ${ld.name}.` };
        const draft = await draftEmail({ role: "real-estate agent", purpose: "a warm follow-up to a buyer lead", context: `Lead: ${ld.name}, interested in ${ld.interest ?? "a home"}, budget ${ld.budgetCents ? `$${(ld.budgetCents / 100).toLocaleString("en-US")}` : "unknown"}. ${args.note ? `Note: ${args.note}` : ""}` });
        if (draft.isFallback || !draft.subject.trim() || !draft.body.trim()) return { ok: false, message: "Follow-up copy is unavailable. Nothing was sent." };
        return { ok: true, message: "Prepared buyer follow-up copy. Nothing was sent.", data: { leadId: ld.id, toEmail: ld.email, subject: draft.subject, body: draft.body, status: "draft" } };
      }
      case "send_listing_to_buyer": {
        const [leads, listings] = await Promise.all([listLeads(user.id), listListings(user.id)]);
        const ld = resolveNamedRecord(leads, "name", args.leadId, args.name);
        if (!ld.email) return { ok: false, message: `No email on file for ${ld.name}.` };

        const l = resolveNamedRecord(listings, "address", args.listingId, args.address);

        const shareUrl = listingShareUrl(l.shareSlug);
        if (!shareUrl) return { ok: false, message: "This listing has no public page. Review publish_listing before preparing a link for a buyer. Nothing was published or sent." };

        const draft = await draftEmail({
          role: "real-estate agent",
          purpose: "a short email presenting one property to an interested buyer, ending by inviting them to view the listing page",
          context: `Buyer: ${ld.name}, looking for ${ld.interest ?? "a home"}${ld.budgetCents ? `, budget $${(ld.budgetCents / 100).toLocaleString("en-US")}` : ""}. Property: ${l.address}, ${usd(l.priceCents)}, ${l.beds ?? "?"}bd/${l.baths ?? "?"}ba${l.sqft ? `, ${l.sqft} sqft` : ""}.${args.note ? ` Note from the agent: ${args.note}` : ""}`,
        });
        // Append the link ourselves rather than trusting the model to reproduce a URL verbatim.
        if (draft.isFallback || !draft.subject.trim() || !draft.body.trim()) return { ok: false, message: "Listing copy is unavailable. Nothing was sent." };
        const body = `${draft.body}\n\nView the listing: ${shareUrl}`;
        return {
          ok: true,
          message: "Prepared the exact buyer email and existing public link. Nothing was sent or published.",
          data: { listingId: l.id, leadId: ld.id, toEmail: ld.email, subject: draft.subject, body, status: "draft" },
        };
      }
      case "schedule_showing": {
        const address = String(args.address ?? "").trim();
        if (!address) return { ok: false, message: "Which property is the showing for?" };
        const whenRaw = args.when ? String(args.when).trim() : "";
        const parsed = whenRaw ? new Date(whenRaw) : null;
        if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(whenRaw) || !parsed || !Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) throw new AppError("Provide the actual future showing time as ISO datetime with an explicit timezone offset. No showing was recorded.", 400);
        const scheduledAt = parsed.toISOString();
        const s = await createShowing(user.id, {
          address,
          leadName: args.leadName ? String(args.leadName) : undefined,
          scheduledAt,
          source: "assistant",
        });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "showing_scheduled", title: `Showing at ${s.address}`, entityType: "re_showing", entityId: s.id });
        const whenMsg = scheduledAt ? ` for ${parsed!.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}` : whenRaw ? ` (${whenRaw})` : "";
        return { ok: true, message: `Showing recorded for ${s.address}${whenMsg}. This is an Interlink record; no calendar invitation was sent.`, data: s };
      }
      case "lease_renewal": {
        const l = resolveNamedRecord(await listLeases(user.id), "property", args.leaseId, args.property);
        if (!l.tenantEmail) return { ok: false, message: `No tenant email on file for ${l.property}.` };
        // PRD: pull localized pricing trends to inform renewal terms when a ZIP is given.
        // RentCast (paid) gives sale comps; Census (free) gives the median gross rent — which
        // is actually the more relevant benchmark for a lease renewal.
        let marketContext = "";
        const zip = String(args.zipCode ?? "").trim();
        if (zip && isRentCastConfigured()) {
          const stats = await getMarketStats(zip);
          if (stats?.averagePriceCents) {
            marketContext = ` Localized market (ZIP ${stats.zipCode}): average sale price ${usd(stats.averagePriceCents)}${stats.averagePricePerSqftCents ? `, ~${usd(stats.averagePricePerSqftCents)}/sqft` : ""}${stats.totalListings != null ? `, ${stats.totalListings} active listings` : ""} — factor this into a fair renewal adjustment.`;
          }
        } else if (zip && isCensusConfigured()) {
          const c = await getCensusMarketStats(zip);
          if (c?.medianGrossRentCents) {
            marketContext = ` Local benchmark (ZIP ${c.zipCode}, ${c.source}): median gross rent ${usd(c.medianGrossRentCents)}/mo — factor this into a fair renewal adjustment.`;
          }
        }
        const draft = await draftEmail({ role: "property manager", purpose: "a friendly lease-renewal offer", context: `Property: ${l.property}. Tenant: ${l.tenantName ?? ""}. Lease ends ${l.endDate ?? "soon"}. Current rent ${l.rentCents ? `$${(l.rentCents / 100).toLocaleString("en-US")}/mo` : "unknown"}.${marketContext}` });
        if (draft.isFallback || !draft.subject.trim() || !draft.body.trim()) return { ok: false, message: "Renewal copy is unavailable. Nothing was sent." };
        return { ok: true, message: "Prepared renewal copy. Actual terms need review; nothing was sent.", data: { leaseId: l.id, toEmail: l.tenantEmail, subject: draft.subject, body: draft.body, status: "draft" } };
      }
      case "match_buyers": {
        const [leads, listings] = await Promise.all([listLeads(user.id), listListings(user.id)]);
        const inventory = listings.filter((l) => (l.status === "active" || l.status === "pending") && l.currency === "USD");
        if (inventory.length === 0)
          return {
            ok: false,
            message:
              "You have no active listings to match against yet. Add a listing (tell me the address + price), or tap “Load demo” on your dashboard to try this with sample data.",
          };
        const targetName = String(args.name ?? "").trim().toLowerCase();
        const selectedLeads = args.leadId || targetName ? [resolveNamedRecord(leads, "name", args.leadId, args.name)] : leads;
        const buyers = selectedLeads
          .filter((l) => l.stage !== "closed" && l.stage !== "lost")
          .slice(0, 25);
        if (buyers.length === 0)
          return {
            ok: false,
            message: targetName
              ? `No active buyer lead named "${args.name}".`
              : "You have no active buyer leads yet. Add one (give me a name + budget), or tap “Load demo” on your dashboard to load sample buyers and listings.",
          };

        const blocks: string[] = [];
        // Structured mirror of the same result so the app can render cards instead of text.
        const structured: {
          buyerName: string;
          email: string | null;
          stage: string;
          budgetCents: number | null;
          wantBeds: number | null;
          matches: { address: string; priceCents: number; beds: number | null; baths: number | null; sqft: number | null; status: string }[];
        }[] = [];

        for (const b of buyers) {
          const wantBeds = bedsFromInterest(b.interest);
          const matches = inventory
            .filter((l) => (b.budgetCents ? l.priceCents <= b.budgetCents : true))
            .filter((l) => (wantBeds != null && l.beds != null ? l.beds >= wantBeds : true))
            .sort((a, c) => c.priceCents - a.priceCents) // best they can afford first
            .slice(0, 3);
          const lines = matches.length
            ? matches.map((l) => `   • ${l.address} — ${usd(l.priceCents)} | ${l.beds ?? "?"}bd/${l.baths ?? "?"}ba`).join("\n")
            : "   • (no current listing fits their budget/criteria)";
          blocks.push(`${b.name}${b.budgetCents ? ` (budget ${usd(b.budgetCents)}${wantBeds ? `, ${wantBeds}bd+` : ""})` : ""}:\n${lines}`);
          structured.push({
            buyerName: b.name,
            email: b.email,
            stage: b.stage,
            budgetCents: b.budgetCents,
            wantBeds,
            matches: matches.map((l) => ({
              address: l.address,
              priceCents: l.priceCents,
              beds: l.beds,
              baths: l.baths,
              sqft: l.sqft,
              status: l.status,
            })),
          });
        }
        return {
          ok: true,
          message: `Buyer ↔ listing matches (up to 25 buyers; stored buyer budgets are USD, no currency conversion):\n\n${blocks.join("\n\n")}`,
          data: {
            kind: "buyer_matches",
            buyerCount: buyers.length,
            listingCount: inventory.length,
            buyers: structured,
          },
        };
      }
      case "search_market": {
        if (!args.zipCode && (!String(args.city ?? "").trim() || !String(args.state ?? "").trim())) return { ok: false, message: "Choose a city and state or a ZIP code before searching." };
        if ([args.beds, args.maxPrice].some(value => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) return { ok: false, message: "Use nonnegative search filters." };
        const searchArgs = {
          city: args.city ? String(args.city) : undefined,
          state: args.state ? String(args.state) : undefined,
          zipCode: args.zipCode ? String(args.zipCode) : undefined,
          beds: typeof args.beds === "number" ? args.beds : undefined,
          maxPriceDollars: typeof args.maxPrice === "number" ? args.maxPrice : undefined,
          limit: 15,
        };
        // Source preference: RentCast → RapidAPI Realtor.com → SimplyRETS, falling through on an
        // EMPTY result, not just a missing key. A configured-but-exhausted RentCast free tier
        // (50 calls/mo) returns [] and would otherwise dead-end the search with "no listings"
        // even though the keyless SimplyRETS feed would have answered.
        const sources: { name: string; run: () => Promise<MarketListing[]> }[] = [];
        if (isRentCastConfigured()) sources.push({ name: "RentCast", run: () => searchListings(searchArgs) });
        if (isRapidListingsConfigured()) sources.push({ name: "Realtor.com", run: () => searchRapidListings(searchArgs) });
        sources.push({
          name: isSimplyRetsLive() ? "SimplyRETS" : "SimplyRETS demo MLS (Houston, TX metro)",
          run: () => searchSimplyRets(searchArgs),
        });

        let results: MarketListing[] = [];
        let source = "";
        for (const s of sources) {
          results = await s.run();
          source = s.name;
          if (results.length > 0) break; // first source that actually returns inventory wins
        }
        if (results.length === 0) return { ok: true, message: "No active for-sale listings matched that search (or the area returned no data)." };
        const lines = results.map((l) => `- ${l.address}${l.city ? `, ${l.city}${l.state ? `, ${l.state}` : ""}` : ""} — ${l.priceCents ? usd(l.priceCents) : "price N/A"} | ${l.beds ?? "?"}bd/${l.baths ?? "?"}ba${l.sqft ? ` | ${l.sqft.toLocaleString()} sqft` : ""}`);
        const isDemo = source.includes("demo");
        return { ok: true, message: `Found ${results.length} ${isDemo ? "demonstration listing(s), not verified live inventory" : "source-returned for-sale listing(s)"} via ${source}:\n${lines.join("\n")}`, data: { source, isDemo, listings: results } };
      }
      case "market_report": {
        const zip = String(args.zipCode ?? "").trim();
        if (!/^\d{5}$/.test(zip)) return { ok: false, message: "Choose a five-digit US ZIP code for the market-data source." };
        const line = (label: string, cents: number | null) => (cents != null ? `- ${label}: ${usd(cents)}` : null);

        // Prefer RentCast when configured (live for-sale stats); otherwise use the FREE
        // US Census ACS data (median home value, median rent, ownership) — no cost.
        if (isRentCastConfigured()) {
          const s = await getMarketStats(zip);
          if (s) {
            const body = [
              `Market report — ${s.zipCode}`,
              line("Average sale price", s.averagePriceCents),
              line("Median sale price", s.medianPriceCents),
              line("Price range", s.minPriceCents),
              s.maxPriceCents != null ? `  to ${usd(s.maxPriceCents)}` : null,
              line("Avg price / sqft", s.averagePricePerSqftCents),
              s.totalListings != null ? `- Active listings: ${s.totalListings}` : null,
              s.newListings != null ? `- New this period: ${s.newListings}` : null,
              "(Source: RentCast)",
            ].filter(Boolean).join("\n");
            return { ok: true, message: body };
          }
        }

        if (isCensusConfigured()) {
          const c = await getCensusMarketStats(zip);
          if (c && (c.medianHomeValueCents != null || c.medianGrossRentCents != null)) {
            const body = [
              `Market report — ${c.zipCode}${c.areaName ? ` (${c.areaName.replace(/^ZCTA5\s*/, "")})` : ""}`,
              line("Median home value", c.medianHomeValueCents),
              c.medianGrossRentCents != null ? `- Median gross rent: ${usd(c.medianGrossRentCents)}/mo` : null,
              c.ownerOccupiedPct != null ? `- Owner-occupied: ${c.ownerOccupiedPct}%` : null,
              `(Source: ${c.source})`,
            ].filter(Boolean).join("\n");
            return { ok: true, message: body };
          }
          return { ok: true, message: `No Census market data is available for ${zip}.` };
        }

        return {
          ok: false,
          message:
            "No market-data source is configured. Set CENSUS_API_KEY (free — api.census.gov/data/key_signup.html) for area market reports, or RENTCAST_API_KEY for live for-sale stats.",
        };
      }
      case "transaction_tasks": {
        const property = String(args.property ?? "").trim();
        if (!property) return { ok: false, message: "Which property is under contract?" };
        // Standard residential purchase timeline, counted back from the close date.
        const date = String(args.closeDate ?? "");
        const close = new Date(date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close.getTime()) || close.toISOString().slice(0, 10) !== date || close.getTime() <= Date.now()) return { ok: false, message: "Provide the actual agreed future closing date as YYYY-MM-DD. No deadline was invented." };
        const dayBefore = (n: number) => {
          const d = new Date(close.getTime() - n * 864e5);
          return d.toISOString().slice(0, 10);
        };
        const milestones: [string, string][] = [
          ["Open escrow & deliver earnest money", dayBefore(28)],
          ["Schedule home inspection", dayBefore(25)],
          ["Complete inspection & negotiate repairs", dayBefore(20)],
          ["Order appraisal", dayBefore(18)],
          ["Buyer finalizes mortgage / loan approval", dayBefore(14)],
          ["Title search & preliminary title report", dayBefore(12)],
          ["Secure homeowner's insurance", dayBefore(10)],
          ["Remove contingencies", dayBefore(7)],
          ["Final walkthrough", dayBefore(2)],
          ["Sign closing documents & fund", dayBefore(1)],
          ["Close & hand over keys", close.toISOString().slice(0, 10)],
        ];
        const body = [
          `Closing checklist — ${property}`,
          `Target close: ${close.toISOString().slice(0, 10)}`,
          "",
          ...milestones.map(([task, due]) => `- [ ] ${due} — ${task}`),
        ].join("\n");
        return { ok: true, message: `${body}\n\nSuggested template dates only. Validate against the actual contract and adjust past milestones. No tasks were created.`, data: { property, closeDate: date, milestones, status: "draft" } };
      }
      default:
        return { ok: false, message: `Unsupported action: ${name}.` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function mapListing(r: { id: string; address: string; price_cents: string | number; currency: string; beds: number | null; baths: number | null; sqft: number | null; status: ListingStatus; description: string | null; source: string; created_at: Date; photos?: string[] | null; share_slug?: string | null }): Listing {
  return { id: r.id, address: r.address, priceCents: typeof r.price_cents === "string" ? parseInt(r.price_cents, 10) : r.price_cents, currency: r.currency, beds: r.beds, baths: r.baths, sqft: r.sqft, status: r.status, description: r.description, source: r.source, createdAt: r.created_at, photos: Array.isArray(r.photos) ? r.photos : [], shareSlug: r.share_slug ?? null };
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
  reviewAction: reviewRealEstateAction,
  readOnlyTools: ["draft_listing_description", "follow_up_lead", "lease_renewal", "match_buyers", "send_listing_to_buyer", "search_market", "market_report", "transaction_tasks"],
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
