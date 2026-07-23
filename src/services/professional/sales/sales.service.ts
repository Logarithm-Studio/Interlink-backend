/**
 * Sales & Business Development vertical (Professional Mode, incl. merged Marketing).
 *
 * Self-contained CRM (contacts, deals, activities, reps, contracts) + the 5 PRD
 * workflows implemented with Gemini + Gmail + Google Calendar:
 *   1. Lead enrichment   2. Post-meeting follow-up   3. Contract generation
 *   4. Inbound routing    5. Pipeline cleaning (autonomy)
 */

import { randomUUID } from "crypto";
import { query } from "../../../config/db";
import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { sendProfessionalEmail } from "../email";
import { draftEmail } from "../draft";
import { geminiGenerateContent, isGeminiLive } from "../../ai/geminiClient";
import { scheduleLeadMeeting } from "../../sales/calendar-sales.service";
import {
  syncPipelineToTrello,
  importDealsFromTrello,
  postPipelineDigestToSlack,
  salesConnectionsLine,
} from "./integrations";
import type { GeminiToolFunction } from "../../ai/geminiClient";
import type { AutomationProposal, PersonaVertical } from "../registry";

const PERSONA = "sales";

// ─── Types ──────────────────────────────────────────────────────────────────
export type DealStage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost" | "nurture";
export type ContractStatus = "draft" | "sent" | "signed" | "declined";

export interface SalesContact {
  id: string; name: string; email: string | null; company: string | null; title: string | null;
  phone: string | null; notes: string | null; territory: string | null; domain: string | null;
  industry: string | null; source: string; lastContactedAt: Date | null; createdAt: Date;
}
export interface SalesDeal {
  id: string; title: string; contactName: string | null; company: string | null; amountCents: number;
  currency: string; stage: DealStage; closeDate: string | null; notes: string | null;
  ownerRep: string | null; lastActivityAt: Date | null; source: string; createdAt: Date;
}
export interface SalesActivity { id: string; dealId: string | null; kind: string; note: string | null; createdAt: Date }
export interface SalesRep { id: string; name: string; email: string | null; territory: string | null; createdAt: Date }
export interface SalesContract {
  id: string; dealId: string | null; title: string; body: string | null; amountCents: number;
  currency: string; status: ContractStatus; sentAt: Date | null; signedAt: Date | null; createdAt: Date;
}
export interface DealDetail { deal: SalesDeal; contact: SalesContact | null; activities: SalesActivity[]; contracts: SalesContract[] }
export interface SalesOverview {
  briefing: string;
  pipelineValueCents: number;
  openCount: number;
  wonValueCents: number;
  stageBreakdown: { stage: DealStage; count: number; valueCents: number }[];
  atRisk: { id: string; title: string; company: string | null; amountCents: number; stage: DealStage }[];
  contractsOut: number;
}

const CONTACT_COLS =
  "id, name, email, company, title, phone, notes, territory, domain, industry, source, last_contacted_at, created_at";
const DEAL_COLS =
  "id, title, contact_name, company, amount_cents, currency, stage, close_date, notes, owner_rep, last_activity_at, source, created_at";

// ─── Contacts ────────────────────────────────────────────────────────────────
export async function listContacts(userId: string): Promise<SalesContact[]> {
  const res = await query(`SELECT ${CONTACT_COLS} FROM sales_contacts WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(mapContact as never);
}
export async function getContact(userId: string, id: string): Promise<SalesContact | null> {
  const res = await query(`SELECT ${CONTACT_COLS} FROM sales_contacts WHERE id = $1 AND user_id = $2`, [id, userId]);
  return res.rows[0] ? mapContact(res.rows[0] as never) : null;
}
async function findContactByName(userId: string, name: string): Promise<SalesContact | null> {
  const all = await listContacts(userId);
  const n = name.trim().toLowerCase();
  return all.find((c) => c.name.toLowerCase() === n) ?? all.find((c) => c.name.toLowerCase().includes(n)) ?? null;
}
export async function createContact(
  userId: string,
  data: { name: string; email?: string; company?: string; title?: string; phone?: string; notes?: string; territory?: string; domain?: string; industry?: string; source?: string },
): Promise<SalesContact> {
  const res = await query(
    `INSERT INTO sales_contacts (user_id, name, email, company, title, phone, notes, territory, domain, industry, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${CONTACT_COLS}`,
    [userId, data.name, data.email ?? null, data.company ?? null, data.title ?? null, data.phone ?? null, data.notes ?? null, data.territory ?? null, data.domain ?? null, data.industry ?? null, data.source ?? "manual"],
  );
  return mapContact(res.rows[0] as never);
}
export async function updateContact(
  userId: string, id: string,
  patch: { email?: string; company?: string; title?: string; territory?: string; domain?: string; industry?: string },
): Promise<SalesContact | null> {
  const res = await query(
    `UPDATE sales_contacts SET
       email=COALESCE($3,email), company=COALESCE($4,company), title=COALESCE($5,title),
       territory=COALESCE($6,territory), domain=COALESCE($7,domain), industry=COALESCE($8,industry), updated_at=now()
     WHERE id=$1 AND user_id=$2 RETURNING ${CONTACT_COLS}`,
    [id, userId, patch.email ?? null, patch.company ?? null, patch.title ?? null, patch.territory ?? null, patch.domain ?? null, patch.industry ?? null],
  );
  return res.rows[0] ? mapContact(res.rows[0] as never) : null;
}

// ─── Deals ───────────────────────────────────────────────────────────────────
export async function listDeals(userId: string): Promise<SalesDeal[]> {
  const res = await query(`SELECT ${DEAL_COLS} FROM sales_deals WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(mapDeal as never);
}
export async function getDeal(userId: string, id: string): Promise<SalesDeal | null> {
  const res = await query(`SELECT ${DEAL_COLS} FROM sales_deals WHERE id = $1 AND user_id = $2`, [id, userId]);
  return res.rows[0] ? mapDeal(res.rows[0] as never) : null;
}
async function findDealByTitle(userId: string, title: string): Promise<SalesDeal | null> {
  const all = await listDeals(userId);
  const t = title.trim().toLowerCase();
  return all.find((d) => d.title.toLowerCase() === t) ?? all.find((d) => d.title.toLowerCase().includes(t)) ?? null;
}
export async function createDeal(
  userId: string,
  data: { title: string; contactName?: string; company?: string; amountCents?: number; currency?: string; stage?: DealStage; closeDate?: string; notes?: string; source?: string },
): Promise<SalesDeal> {
  const res = await query(
    `INSERT INTO sales_deals (user_id, title, contact_name, company, amount_cents, currency, stage, close_date, notes, source, last_activity_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING ${DEAL_COLS}`,
    [userId, data.title, data.contactName ?? null, data.company ?? null, data.amountCents ?? 0, data.currency ?? "USD", data.stage ?? "lead", data.closeDate ?? null, data.notes ?? null, data.source ?? "manual"],
  );
  return mapDeal(res.rows[0] as never);
}
export async function updateDeal(
  userId: string, id: string,
  patch: { stage?: DealStage; amountCents?: number; notes?: string; ownerRep?: string; contactName?: string },
): Promise<SalesDeal | null> {
  const res = await query(
    `UPDATE sales_deals SET
       stage=COALESCE($3,stage), amount_cents=COALESCE($4,amount_cents), notes=COALESCE($5,notes),
       owner_rep=COALESCE($6,owner_rep), contact_name=COALESCE($7,contact_name), last_activity_at=now(), updated_at=now()
     WHERE id=$1 AND user_id=$2 RETURNING ${DEAL_COLS}`,
    [id, userId, patch.stage ?? null, patch.amountCents ?? null, patch.notes ?? null, patch.ownerRep ?? null, patch.contactName ?? null],
  );
  return res.rows[0] ? mapDeal(res.rows[0] as never) : null;
}

// ─── Activities ────────────────────────────────────────────────────────────────
export async function logActivity(userId: string, data: { dealId?: string; contactId?: string; kind: string; note?: string }): Promise<void> {
  await query(
    `INSERT INTO sales_activities (user_id, deal_id, contact_id, kind, note) VALUES ($1,$2,$3,$4,$5)`,
    [userId, data.dealId ?? null, data.contactId ?? null, data.kind, data.note ?? null],
  );
  if (data.dealId) await query(`UPDATE sales_deals SET last_activity_at = now() WHERE id = $1 AND user_id = $2`, [data.dealId, userId]);
}
export async function listActivitiesForDeal(userId: string, dealId: string): Promise<SalesActivity[]> {
  const res = await query<{ id: string; deal_id: string | null; kind: string; note: string | null; created_at: Date }>(
    `SELECT id, deal_id, kind, note, created_at FROM sales_activities WHERE user_id=$1 AND deal_id=$2 ORDER BY created_at DESC`,
    [userId, dealId],
  );
  return res.rows.map((r) => ({ id: r.id, dealId: r.deal_id, kind: r.kind, note: r.note, createdAt: r.created_at }));
}

// ─── Reps ────────────────────────────────────────────────────────────────────
export async function listReps(userId: string): Promise<SalesRep[]> {
  const res = await query<{ id: string; name: string; email: string | null; territory: string | null; created_at: Date }>(
    `SELECT id, name, email, territory, created_at FROM sales_reps WHERE user_id=$1 ORDER BY created_at`, [userId]);
  return res.rows.map((r) => ({ id: r.id, name: r.name, email: r.email, territory: r.territory, createdAt: r.created_at }));
}
export async function createRep(userId: string, data: { name: string; email?: string; territory?: string }): Promise<SalesRep> {
  const res = await query<{ id: string; name: string; email: string | null; territory: string | null; created_at: Date }>(
    `INSERT INTO sales_reps (user_id, name, email, territory) VALUES ($1,$2,$3,$4) RETURNING id, name, email, territory, created_at`,
    [userId, data.name, data.email ?? null, data.territory ?? null]);
  const r = res.rows[0];
  return { id: r.id, name: r.name, email: r.email, territory: r.territory, createdAt: r.created_at };
}

// ─── Contracts ───────────────────────────────────────────────────────────────
const CONTRACT_COLS = "id, deal_id, title, body, amount_cents, currency, status, sent_at, signed_at, created_at";
export async function listContracts(userId: string): Promise<SalesContract[]> {
  const res = await query(`SELECT ${CONTRACT_COLS} FROM sales_contracts WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(mapContract2 as never);
}
export async function listContractsForDeal(userId: string, dealId: string): Promise<SalesContract[]> {
  const res = await query(`SELECT ${CONTRACT_COLS} FROM sales_contracts WHERE user_id=$1 AND deal_id=$2 ORDER BY created_at DESC`, [userId, dealId]);
  return res.rows.map(mapContract2 as never);
}
async function insertContract(userId: string, data: { dealId: string; title: string; body: string; amountCents: number }): Promise<SalesContract> {
  const res = await query(
    `INSERT INTO sales_contracts (user_id, deal_id, title, body, amount_cents, status, sent_at)
     VALUES ($1,$2,$3,$4,$5,'sent', now()) RETURNING ${CONTRACT_COLS}`,
    [userId, data.dealId, data.title, data.body, data.amountCents]);
  return mapContract2(res.rows[0] as never);
}

// ─── Detail + overview ───────────────────────────────────────────────────────
export async function getDealDetail(userId: string, dealId: string): Promise<DealDetail | null> {
  const deal = await getDeal(userId, dealId);
  if (!deal) return null;
  const [activities, contracts] = await Promise.all([listActivitiesForDeal(userId, dealId), listContractsForDeal(userId, dealId)]);
  const contact = deal.contactName ? await findContactByName(userId, deal.contactName) : null;
  return { deal, contact, activities, contracts };
}

export async function getOverview(userId: string): Promise<SalesOverview> {
  const [deals, contracts] = await Promise.all([listDeals(userId), listContracts(userId)]);
  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const won = deals.filter((d) => d.stage === "won");
  const stages: DealStage[] = ["lead", "qualified", "proposal", "negotiation", "won", "lost", "nurture"];
  const stageBreakdown = stages
    .map((stage) => {
      const inStage = deals.filter((d) => d.stage === stage);
      return { stage, count: inStage.length, valueCents: inStage.reduce((s, d) => s + d.amountCents, 0) };
    })
    .filter((s) => s.count > 0);
  const cutoff = Date.now() - 14 * 86_400_000;
  const atRisk = open
    .filter((d) => (d.lastActivityAt ? new Date(d.lastActivityAt).getTime() : new Date(d.createdAt).getTime()) < cutoff)
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 5)
    .map((d) => ({ id: d.id, title: d.title, company: d.company, amountCents: d.amountCents, stage: d.stage }));
  const pipelineValueCents = open.reduce((s, d) => s + d.amountCents, 0);
  const fmt = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
  return {
    briefing: `${open.length} open deal(s) worth ${fmt(pipelineValueCents)}; ${atRisk.length} need attention.`,
    pipelineValueCents,
    openCount: open.length,
    wonValueCents: won.reduce((s, d) => s + d.amountCents, 0),
    stageBreakdown,
    atRisk,
    contractsOut: contracts.filter((c) => c.status === "sent").length,
  };
}

// ─── Inbound form key ──────────────────────────────────────────────────────────
export async function getOrCreateFormKey(userId: string): Promise<string> {
  const existing = await query<{ form_key: string }>(`SELECT form_key FROM sales_settings WHERE user_id=$1`, [userId]);
  if (existing.rows[0]) return existing.rows[0].form_key;
  const key = randomUUID().replace(/-/g, "").slice(0, 18);
  await query(`INSERT INTO sales_settings (user_id, form_key) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`, [userId, key]);
  const res = await query<{ form_key: string }>(`SELECT form_key FROM sales_settings WHERE user_id=$1`, [userId]);
  return res.rows[0].form_key;
}
export async function captureInboundLead(formKey: string, data: { name: string; email?: string; company?: string; message?: string }): Promise<{ ok: boolean }> {
  const res = await query<{ user_id: string }>(`SELECT user_id FROM sales_settings WHERE form_key=$1`, [formKey]);
  const userId = res.rows[0]?.user_id;
  if (!userId) return { ok: false };
  const c = await createContact(userId, { name: data.name, email: data.email, company: data.company, notes: data.message, source: "inbound" });
  await recordActivity({ userId, persona: PERSONA, kind: "inbound_lead", title: `Inbound lead: ${c.name}`, detail: data.company ?? undefined, entityType: "sales_contact", entityId: c.id, status: "suggested", payload: { persona: PERSONA, tool: "route_lead", args: { contactName: c.name } } });
  return { ok: true };
}

// ─── Workflow: lead enrichment ──────────────────────────────────────────────────
export async function enrichLead(userId: string, emailText: string): Promise<{ contact: SalesContact | null; isFallback: boolean }> {
  if (!isGeminiLive()) return { contact: null, isFallback: true };
  try {
    const result = await geminiGenerateContent({
      system:
        "Extract the sender/lead from this email. Return ONLY JSON: " +
        '{"name":string,"email":string,"company":string,"title":string,"domain":string,"industry":string}. ' +
        "Infer company/domain/industry from signatures and the email address when possible. Use empty strings if unknown.",
      parts: [{ text: emailText.slice(0, 6000) }],
      json: true,
      maxOutputTokens: 500,
    });
    const o = JSON.parse(result.raw) as Record<string, string>;
    const name = (o.name || "").trim();
    if (!name) return { contact: null, isFallback: false };
    const email = (o.email || "").trim() || undefined;
    let contact = email ? (await listContacts(userId)).find((c) => (c.email ?? "").toLowerCase() === email.toLowerCase()) ?? null : null;
    const fields = { email, company: o.company || undefined, title: o.title || undefined, domain: o.domain || undefined, industry: o.industry || undefined };
    if (contact) {
      contact = await updateContact(userId, contact.id, fields);
    } else {
      contact = await createContact(userId, { name, ...fields, source: "email" });
    }
    if (contact) await recordActivity({ userId, persona: PERSONA, kind: "lead_enriched", title: `Enriched ${contact.name}`, detail: contact.company ?? undefined, entityType: "sales_contact", entityId: contact.id });
    return { contact, isFallback: false };
  } catch {
    return { contact: null, isFallback: true };
  }
}

// ─── Workflow: post-meeting follow-up ────────────────────────────────────────────
async function meetingFollowupCore(user: AppUser, deal: SalesDeal, extracted: { painPoints: string[]; summary: string }): Promise<{ ok: boolean; message: string }> {
  const contact = deal.contactName ? await findContactByName(user.id, deal.contactName) : null;
  const painText = extracted.painPoints.length ? `Pain points: ${extracted.painPoints.join("; ")}.` : "";
  const draft = await draftEmail({
    role: "sales representative",
    purpose: "a follow-up email after a discovery call that acknowledges the client's pain points and proposes next steps",
    context: `Deal: ${deal.title} (${deal.company ?? ""}). ${painText} Summary: ${extracted.summary}`,
  });
  if (contact?.email) {
    await sendProfessionalEmail({ user, to: contact.email, subject: draft.subject, body: draft.body, tag: "sales_meeting_followup" });
  }
  const nextStage: DealStage = deal.stage === "lead" ? "qualified" : deal.stage === "qualified" ? "proposal" : deal.stage;
  await updateDeal(user.id, deal.id, { stage: nextStage });
  await logActivity(user.id, { dealId: deal.id, kind: "meeting_logged", note: `Discovery completed. ${painText} ${extracted.summary}`.trim() });
  await recordActivity({ userId: user.id, persona: PERSONA, kind: "meeting_followup", title: `Follow-up sent for ${deal.title}`, detail: contact?.email ? `to ${contact.name}` : "logged (no contact email)", entityType: "sales_deal", entityId: deal.id });
  return { ok: true, message: contact?.email ? `Follow-up sent to ${contact.name}; deal moved to ${nextStage}.` : `Logged meeting; deal moved to ${nextStage} (no contact email to send to).` };
}

export async function processMeetingTranscript(user: AppUser, dealId: string, transcript: string): Promise<{ ok: boolean; message: string }> {
  const deal = await getDeal(user.id, dealId);
  if (!deal) return { ok: false, message: "Deal not found." };
  let extracted = { painPoints: [] as string[], summary: transcript.slice(0, 400) };
  if (isGeminiLive()) {
    try {
      const result = await geminiGenerateContent({
        system: 'Analyze this sales call transcript. Return ONLY JSON: {"painPoints":string[],"summary":string}.',
        parts: [{ text: transcript.slice(0, 12000) }],
        json: true,
        maxOutputTokens: 600,
      });
      const o = JSON.parse(result.raw) as { painPoints?: unknown; summary?: unknown };
      extracted = {
        painPoints: Array.isArray(o.painPoints) ? o.painPoints.map(String).slice(0, 8) : [],
        summary: typeof o.summary === "string" ? o.summary : extracted.summary,
      };
    } catch {
      /* fall through with defaults */
    }
  }
  return meetingFollowupCore(user, deal, extracted);
}

// ─── Workflow: contract generation ───────────────────────────────────────────────
export async function generateContract(user: AppUser, dealId: string): Promise<{ ok: boolean; message: string; contract?: SalesContract }> {
  const deal = await getDeal(user.id, dealId);
  if (!deal) return { ok: false, message: "Deal not found." };
  const contact = deal.contactName ? await findContactByName(user.id, deal.contactName) : null;
  const fmt = `$${Math.round(deal.amountCents / 100).toLocaleString("en-US")}`;
  const draft = await draftEmail({
    role: "sales representative drafting a service agreement",
    purpose: "a clear, professional proposal/contract with scope, term, and pricing (put the FULL contract text in the body field)",
    context: `Client: ${contact?.name ?? deal.contactName ?? ""}${deal.company ? `, ${deal.company}` : ""}. Deal: ${deal.title}. Total value: ${fmt}.`,
  });
  const contract = await insertContract(user.id, { dealId: deal.id, title: `${deal.title} — Agreement`, body: draft.body, amountCents: deal.amountCents });
  if (contact?.email) {
    await sendProfessionalEmail({
      user, to: contact.email, subject: `Agreement for your review — ${deal.title}`,
      body: `${draft.body}\n\n— To accept, reply "I accept" to this email and we'll countersign.`,
      tag: "sales_contract",
    });
  }
  await logActivity(user.id, { dealId: deal.id, kind: "contract_sent", note: `Contract sent (${fmt})` });
  await recordActivity({ userId: user.id, persona: PERSONA, kind: "contract_sent", title: `Contract sent for ${deal.title}`, detail: contact?.email ? `to ${contact.name}` : "generated (no email)", entityType: "sales_deal", entityId: deal.id });
  return { ok: true, message: contact?.email ? `Contract emailed to ${contact.name}.` : "Contract generated but not emailed — add a contact with an email to this deal, then generate again to send it.", contract };
}

export async function markContractSigned(user: AppUser, dealId: string): Promise<{ ok: boolean; message: string }> {
  const contracts = await listContractsForDeal(user.id, dealId);
  const target = contracts.find((c) => c.status === "sent") ?? contracts[0];
  if (!target) return { ok: false, message: "No contract on this deal yet." };
  await query(`UPDATE sales_contracts SET status='signed', signed_at=now() WHERE id=$1 AND user_id=$2`, [target.id, user.id]);
  await updateDeal(user.id, dealId, { stage: "won" });
  await logActivity(user.id, { dealId, kind: "contract_signed", note: "Contract signed — deal won" });
  await recordActivity({ userId: user.id, persona: PERSONA, kind: "contract_signed", title: `Contract signed`, entityType: "sales_deal", entityId: dealId });
  return { ok: true, message: "Marked signed; deal moved to won." };
}

// ─── Workflow: inbound route optimization ────────────────────────────────────────
export async function routeLead(user: AppUser, contactName: string): Promise<{ ok: boolean; message: string }> {
  const contact = await findContactByName(user.id, contactName);
  if (!contact) return { ok: false, message: "Couldn't find that lead." };
  const reps = await listReps(user.id);
  if (reps.length === 0) return { ok: false, message: "Add a sales rep (with a territory) first." };
  const terr = (contact.territory ?? contact.company ?? "").toLowerCase();
  const rep =
    reps.find((r) => r.territory && terr && (terr.includes(r.territory.toLowerCase()) || r.territory.toLowerCase().includes(terr))) ?? reps[0];
  // Default a 30-min slot tomorrow at 15:00 local server time.
  const start = new Date(); start.setDate(start.getDate() + 1); start.setHours(15, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60_000);
  let scheduled = false;
  if (contact.email) {
    try {
      await scheduleLeadMeeting(user.id, { title: `Intro: ${contact.name} × ${rep.name}`, prospectEmail: contact.email, repEmail: rep.email ?? undefined, startTime: start.toISOString(), endTime: end.toISOString(), notes: `Routed to ${rep.name}${rep.territory ? ` (${rep.territory})` : ""}.` });
      scheduled = true;
    } catch {
      /* calendar not connected — still record the routing */
    }
  }
  await recordActivity({ userId: user.id, persona: PERSONA, kind: "lead_routed", title: `Routed ${contact.name} → ${rep.name}`, detail: scheduled ? "meeting scheduled" : "assigned", entityType: "sales_contact", entityId: contact.id });
  return { ok: true, message: `Assigned ${contact.name} to ${rep.name}${scheduled ? " and scheduled an intro meeting." : "."}` };
}

// ─── Workflow: pipeline cleaning (re-engage) ─────────────────────────────────────
async function reengageDeal(user: AppUser, dealTitle: string): Promise<{ ok: boolean; message: string }> {
  const deal = await findDealByTitle(user.id, dealTitle);
  if (!deal) return { ok: false, message: "Couldn't find that deal." };
  const contact = deal.contactName ? await findContactByName(user.id, deal.contactName) : null;
  const draft = await draftEmail({
    role: "sales representative",
    purpose: "a short, low-pressure re-engagement email to revive a stalled deal",
    context: `Deal: ${deal.title} (${deal.company ?? ""}), currently ${deal.stage}.`,
  });
  if (contact?.email) await sendProfessionalEmail({ user, to: contact.email, subject: draft.subject, body: draft.body, tag: "sales_reengage" });
  await updateDeal(user.id, deal.id, { stage: "nurture" });
  await logActivity(user.id, { dealId: deal.id, kind: "reengaged", note: "Re-engagement sent; moved to nurture" });
  await recordActivity({ userId: user.id, persona: PERSONA, kind: "deal_reengaged", title: `Re-engaged ${deal.title}`, detail: "moved to nurture", entityType: "sales_deal", entityId: deal.id });
  return { ok: true, message: `Re-engaged "${deal.title}"; moved to nurture.` };
}

async function planPipelineCleaning(userId: string): Promise<AutomationProposal[]> {
  const res = await query<{ id: string; title: string }>(
    `SELECT id, title FROM sales_deals
      WHERE user_id = $1 AND stage NOT IN ('won','lost','nurture')
        AND COALESCE(last_activity_at, updated_at) < now() - INTERVAL '30 days'
      ORDER BY COALESCE(last_activity_at, updated_at) ASC LIMIT 10`,
    [userId],
  );
  return res.rows.map((d) => ({ title: `Re-engage stalled deal "${d.title}"`, entityType: "sales_deal", entityId: d.id, tool: "reengage_deal", args: { dealTitle: d.title } }));
}

// ─── Demo seed ──────────────────────────────────────────────────────────────
export async function seedDemo(userId: string): Promise<{ count: number }> {
  // Reset-and-reseed for a clean demo (children first for FK safety).
  await query(`DELETE FROM sales_activities WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM sales_contracts WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM sales_deals WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM sales_contacts WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM sales_reps WHERE user_id = $1`, [userId]);
  const contacts = [
    { name: "Dana Lee", email: "dana@acme.io", company: "Acme Corp", title: "VP Sales", territory: "West" },
    { name: "Sam Rivera", email: "sam@globex.com", company: "Globex LLC", title: "Head of Ops", territory: "East" },
    { name: "Priya Shah", email: "priya@initech.com", company: "Initech", title: "CTO", territory: "West" },
  ];
  for (const c of contacts) await createContact(userId, { ...c, source: "demo" });
  const deals: { title: string; contactName: string; company: string; amountCents: number; stage: DealStage }[] = [
    { title: "Acme — annual platform", contactName: "Dana Lee", company: "Acme Corp", amountCents: 4800000, stage: "proposal" },
    { title: "Globex — pilot expansion", contactName: "Sam Rivera", company: "Globex LLC", amountCents: 1200000, stage: "negotiation" },
    { title: "Initech — new logo", contactName: "Priya Shah", company: "Initech", amountCents: 2600000, stage: "qualified" },
    { title: "Umbrella — renewal", contactName: "", company: "Umbrella Inc", amountCents: 900000, stage: "lead" },
  ];
  for (const d of deals) await createDeal(userId, { ...d, source: "demo" });
  await createRep(userId, { name: "Alex West", email: "alex@yourco.com", territory: "West" });
  await createRep(userId, { name: "Robin East", email: "robin@yourco.com", territory: "East" });
  return { count: deals.length };
}

// ─── AI snapshot ────────────────────────────────────────────────────────────
async function buildSnapshot(userId: string): Promise<string> {
  const [deals, contacts, contracts, connLine] = await Promise.all([
    listDeals(userId), listContacts(userId), listContracts(userId), salesConnectionsLine(userId),
  ]);
  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US")}`;
  return [
    connLine,
    `Open pipeline: ${fmt(open.reduce((s, d) => s + d.amountCents, 0))} across ${open.length} deal(s). Contacts: ${contacts.length}. Contracts out: ${contracts.filter((c) => c.status === "sent").length}.`,
    "Deals:",
    ...deals.slice(0, 20).map((d) => `- ${d.title} | ${d.company ?? "—"} | ${fmt(d.amountCents)} | stage=${d.stage} | contact=${d.contactName ?? "—"}`),
    "Contacts:",
    ...contacts.slice(0, 15).map((c) => `- ${c.name} | ${c.company ?? "—"} | ${c.email ?? "no-email"} | ${c.title ?? ""}${c.territory ? ` | ${c.territory}` : ""}`),
  ].join("\n");
}

// ─── Agent tools ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = [
  "You are the user's AI sales & business-development assistant inside the Interlink app.",
  "Answer questions about the pipeline/contacts using ONLY the DATA SNAPSHOT, or perform an action by calling a function when the user asks.",
  "Core workflows you can run:",
  "- Lead enrichment: when the user pastes/attaches an email, call enrich_lead to extract and add/update the contact.",
  "- Post-meeting follow-up: given a call transcript (text or attached file), extract the client's pain points and call meeting_followup for the relevant deal — it emails a follow-up and advances the stage.",
  "- Contract generation: generate_contract drafts a proposal from a deal and emails it for signature; mark_contract_signed closes the deal won.",
  "- Inbound routing: route_lead assigns a lead to a rep by territory and schedules an intro meeting.",
  "- Pipeline hygiene: reengage_deal revives a stalled deal, advance_stage moves a deal, and post_pipeline_to_slack / sync_pipeline_to_trello share the pipeline.",
  "- Campaigns: draft_campaign writes AND sends a marketing email to your matching contacts.",
  "Resolve deals and contacts by their name from the snapshot; never invent contacts, companies, or numbers.",
  "You never send anything without confirmation — the app asks the user to confirm each write action before it executes.",
].join("\n");

const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost", "nurture"];
const TOOLS: GeminiToolFunction[] = [
  { name: "create_contact", description: "Add a new sales contact/prospect.", parameters: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, company: { type: "string" }, title: { type: "string" } }, required: ["name"] } },
  { name: "create_deal", description: "Create a new deal/opportunity.", parameters: { type: "object", properties: { title: { type: "string" }, contactName: { type: "string" }, company: { type: "string" }, amountCents: { type: "number" }, stage: { type: "string", enum: STAGES } }, required: ["title"] } },
  { name: "advance_stage", description: "Move a deal to a new pipeline stage.", parameters: { type: "object", properties: { dealTitle: { type: "string" }, stage: { type: "string", enum: STAGES } }, required: ["dealTitle", "stage"] } },
  { name: "draft_followup", description: "Draft and send a follow-up email to a contact.", parameters: { type: "object", properties: { contactName: { type: "string" }, note: { type: "string" } }, required: ["contactName"] } },
  { name: "draft_campaign", description: "Draft AND send a marketing campaign email to your contacts. Optionally filter recipients with 'audience' (matched against company/title/territory).", parameters: { type: "object", properties: { topic: { type: "string" }, audience: { type: "string", description: "Optional filter, e.g. a company, title, or territory. Omit to send to all contacts with an email." } }, required: ["topic"] } },
  { name: "enrich_lead", description: "Extract & enrich a lead from a pasted or attached email; creates/updates a contact.", parameters: { type: "object", properties: { emailText: { type: "string", description: "The email text to parse (if pasted)." } } } },
  { name: "meeting_followup", description: "After a call: send a follow-up that addresses pain points and advance the deal.", parameters: { type: "object", properties: { dealTitle: { type: "string" }, painPoints: { type: "array", items: { type: "string" } }, summary: { type: "string" } }, required: ["dealTitle"] } },
  { name: "generate_contract", description: "Generate a proposal/contract from a deal and email it for signature.", parameters: { type: "object", properties: { dealTitle: { type: "string" } }, required: ["dealTitle"] } },
  { name: "mark_contract_signed", description: "Mark a deal's contract as signed (moves the deal to won).", parameters: { type: "object", properties: { dealTitle: { type: "string" } }, required: ["dealTitle"] } },
  { name: "route_lead", description: "Assign a lead to a rep by territory and schedule an intro meeting.", parameters: { type: "object", properties: { contactName: { type: "string" } }, required: ["contactName"] } },
  { name: "reengage_deal", description: "Send a re-engagement email for a stalled deal and move it to nurture.", parameters: { type: "object", properties: { dealTitle: { type: "string" } }, required: ["dealTitle"] } },
  { name: "sync_pipeline_to_trello", description: "Push your open deals to your Trello board as cards (one per stage list).", parameters: { type: "object", properties: {} } },
  { name: "import_from_trello", description: "Pull cards from your Trello board and create deals for any that aren't in the pipeline yet.", parameters: { type: "object", properties: {} } },
  { name: "post_pipeline_to_slack", description: "Post a pipeline digest to a Slack channel.", parameters: { type: "object", properties: { channel: { type: "string", description: "Channel name or id (defaults to a channel you're in)." } } } },
  { name: "log_activity", description: "Log a note to the feed.", parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
];

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "create_contact": return `Add contact ${args.name ?? ""}${args.company ? ` (${args.company})` : ""}.`;
    case "create_deal": return `Create deal "${args.title ?? ""}"${args.company ? ` for ${args.company}` : ""}.`;
    case "advance_stage": return `Move "${args.dealTitle ?? "deal"}" to ${args.stage}.`;
    case "draft_followup": return `Draft & send a follow-up to ${args.contactName ?? "the contact"}.`;
    case "draft_campaign": return `Draft & send a campaign about ${args.topic ?? "your product"}${args.audience ? ` to ${args.audience}` : " to your contacts"}.`;
    case "enrich_lead": return `Enrich a lead from the email.`;
    case "meeting_followup": return `Send a post-meeting follow-up for "${args.dealTitle ?? "the deal"}".`;
    case "generate_contract": return `Generate & send a contract for "${args.dealTitle ?? "the deal"}".`;
    case "mark_contract_signed": return `Mark "${args.dealTitle ?? "the deal"}"'s contract signed.`;
    case "route_lead": return `Route ${args.contactName ?? "the lead"} to a rep & schedule a meeting.`;
    case "reengage_deal": return `Re-engage "${args.dealTitle ?? "the deal"}" (→ nurture).`;
    case "sync_pipeline_to_trello": return `Sync your open deals to your Trello board.`;
    case "import_from_trello": return `Import new cards from your Trello board as deals.`;
    case "post_pipeline_to_slack": return `Post a pipeline digest to Slack${args.channel ? ` (#${String(args.channel).replace(/^#/, "")})` : ""}.`;
    case "log_activity": return `Log: ${args.note ?? ""}`;
    default: return `Run ${name}.`;
  }
}

async function executeTool(user: AppUser, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    switch (name) {
      case "create_contact": {
        const c = await createContact(user.id, { name: String(args.name ?? "").trim(), email: args.email ? String(args.email) : undefined, company: args.company ? String(args.company) : undefined, title: args.title ? String(args.title) : undefined, source: "assistant" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "contact_created", title: `Added contact ${c.name}`, entityType: "sales_contact", entityId: c.id });
        return { ok: true, message: `Added ${c.name}.` };
      }
      case "create_deal": {
        const d = await createDeal(user.id, { title: String(args.title ?? "").trim(), contactName: args.contactName ? String(args.contactName) : undefined, company: args.company ? String(args.company) : undefined, amountCents: typeof args.amountCents === "number" ? args.amountCents : undefined, stage: args.stage as DealStage | undefined, source: "assistant" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "deal_created", title: `Created deal ${d.title}`, entityType: "sales_deal", entityId: d.id });
        return { ok: true, message: `Created deal "${d.title}".` };
      }
      case "advance_stage": {
        const match = await findDealByTitle(user.id, String(args.dealTitle ?? ""));
        if (!match) return { ok: false, message: "Couldn't find that deal." };
        await updateDeal(user.id, match.id, { stage: args.stage as DealStage });
        await logActivity(user.id, { dealId: match.id, kind: "stage_changed", note: `→ ${args.stage}` });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "deal_advanced", title: `${match.title} → ${args.stage}`, entityType: "sales_deal", entityId: match.id });
        return { ok: true, message: `Moved "${match.title}" to ${args.stage}.` };
      }
      case "draft_followup": {
        const c = await findContactByName(user.id, String(args.contactName ?? ""));
        if (!c) return { ok: false, message: "Couldn't find that contact." };
        if (!c.email) return { ok: false, message: `No email on file for ${c.name}.` };
        const draft = await draftEmail({ role: "sales representative", purpose: "a warm, concise follow-up email to a prospect", context: `Contact: ${c.name}${c.company ? `, ${c.company}` : ""}${c.title ? `, ${c.title}` : ""}. ${args.note ? `Note: ${args.note}` : ""}` });
        await sendProfessionalEmail({ user, to: c.email, subject: draft.subject, body: draft.body, tag: "sales_followup" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "followup_sent", title: `Follow-up sent to ${c.name}`, detail: draft.subject, entityType: "sales_contact", entityId: c.id });
        return { ok: true, message: `Follow-up sent to ${c.name}.` };
      }
      case "draft_campaign": {
        const draft = await draftEmail({ role: "marketing manager", purpose: "a short marketing campaign email", context: `Topic: ${args.topic ?? ""}. Audience: ${args.audience ?? "prospects"}.` });
        // Send to contacts with an email, optionally filtered by the audience string
        // (matched against company / title / territory) — the merged-in marketing workflow.
        const audience = String(args.audience ?? "").trim().toLowerCase();
        const withEmail = (await listContacts(user.id)).filter((c) => c.email);
        const recipients = audience
          ? withEmail.filter((c) => [c.company, c.title, c.territory].some((f) => (f ?? "").toLowerCase().includes(audience)))
          : withEmail;
        let sent = 0;
        for (const c of recipients) {
          try {
            await sendProfessionalEmail({ user, to: c.email!, subject: draft.subject, body: draft.body, tag: "sales_campaign" });
            sent++;
          } catch {
            /* skip a single failed recipient, keep going */
          }
        }
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "campaign_sent", title: `Campaign sent: ${draft.subject}`, detail: `${sent} recipient(s)` });
        const note = sent > 0
          ? `Sent to ${sent} contact(s).`
          : "No contacts with an email matched — the copy is ready; add recipients and try again.";
        return { ok: true, message: `${note}\n\nSubject: ${draft.subject}\n\n${draft.body}` };
      }
      case "enrich_lead": {
        const text = String(args.emailText ?? "").trim();
        if (!text) return { ok: false, message: "Paste or attach the email to enrich." };
        const { contact, isFallback } = await enrichLead(user.id, text);
        if (isFallback) return { ok: false, message: "AI is offline — couldn't enrich the lead." };
        if (!contact) return { ok: false, message: "Couldn't extract a lead from that email." };
        return { ok: true, message: `Enriched ${contact.name}${contact.company ? ` (${contact.company})` : ""}.` };
      }
      case "meeting_followup": {
        const deal = await findDealByTitle(user.id, String(args.dealTitle ?? ""));
        if (!deal) return { ok: false, message: "Couldn't find that deal." };
        const painPoints = Array.isArray(args.painPoints) ? (args.painPoints as unknown[]).map(String) : [];
        return meetingFollowupCore(user, deal, { painPoints, summary: String(args.summary ?? "") });
      }
      case "generate_contract": {
        const deal = await findDealByTitle(user.id, String(args.dealTitle ?? ""));
        if (!deal) return { ok: false, message: "Couldn't find that deal." };
        const r = await generateContract(user, deal.id);
        return { ok: r.ok, message: r.message };
      }
      case "mark_contract_signed": {
        const deal = await findDealByTitle(user.id, String(args.dealTitle ?? ""));
        if (!deal) return { ok: false, message: "Couldn't find that deal." };
        return markContractSigned(user, deal.id);
      }
      case "route_lead": return routeLead(user, String(args.contactName ?? ""));
      case "reengage_deal": return reengageDeal(user, String(args.dealTitle ?? ""));
      case "sync_pipeline_to_trello": return syncPipelineToTrello(user);
      case "import_from_trello": return importDealsFromTrello(user);
      case "post_pipeline_to_slack": return postPipelineDigestToSlack(user, args.channel ? String(args.channel) : undefined);
      case "log_activity": {
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "note", title: String(args.note ?? "Note") });
        return { ok: true, message: "Logged." };
      }
      default:
        return { ok: false, message: `Unsupported action: ${name}.` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Row mappers ────────────────────────────────────────────────────────────
function mapContact(r: {
  id: string; name: string; email: string | null; company: string | null; title: string | null; phone: string | null; notes: string | null; territory: string | null; domain: string | null; industry: string | null; source: string; last_contacted_at: Date | null; created_at: Date;
}): SalesContact {
  return { id: r.id, name: r.name, email: r.email, company: r.company, title: r.title, phone: r.phone, notes: r.notes, territory: r.territory, domain: r.domain, industry: r.industry, source: r.source, lastContactedAt: r.last_contacted_at, createdAt: r.created_at };
}
function mapDeal(r: {
  id: string; title: string; contact_name: string | null; company: string | null; amount_cents: string | number; currency: string; stage: DealStage; close_date: string | null; notes: string | null; owner_rep: string | null; last_activity_at: Date | null; source: string; created_at: Date;
}): SalesDeal {
  return { id: r.id, title: r.title, contactName: r.contact_name, company: r.company, amountCents: typeof r.amount_cents === "string" ? parseInt(r.amount_cents, 10) : r.amount_cents, currency: r.currency, stage: r.stage, closeDate: r.close_date, notes: r.notes, ownerRep: r.owner_rep, lastActivityAt: r.last_activity_at, source: r.source, createdAt: r.created_at };
}
function mapContract2(r: {
  id: string; deal_id: string | null; title: string; body: string | null; amount_cents: string | number; currency: string; status: ContractStatus; sent_at: Date | null; signed_at: Date | null; created_at: Date;
}): SalesContract {
  return { id: r.id, dealId: r.deal_id, title: r.title, body: r.body, amountCents: typeof r.amount_cents === "string" ? parseInt(r.amount_cents, 10) : r.amount_cents, currency: r.currency, status: r.status, sentAt: r.sent_at, signedAt: r.signed_at, createdAt: r.created_at };
}

// ─── Vertical export ────────────────────────────────────────────────────────
export const salesVertical: PersonaVertical = {
  persona: PERSONA,
  tools: TOOLS,
  systemPrompt: SYSTEM_PROMPT,
  buildSnapshot,
  executeTool,
  summarizeAction,
  seedDemo,
  automations: [
    {
      type: "pipeline_cleaning",
      title: "Pipeline cleaning",
      description: "Every 30 days, re-engage stalled deals and move them to nurture",
      cadenceDays: 30,
      defaultAutonomy: "suggest",
      plan: planPipelineCleaning,
    },
  ],
};
