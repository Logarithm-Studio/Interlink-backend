/**
 * Sales vertical (Professional Mode) — includes merged Marketing.
 * Data model (contacts + deals), demo seed, AI data snapshot, and the agentic
 * tool set the command center exposes to Gemini.
 */

import { query } from "../../../config/db";
import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { sendProfessionalEmail } from "../email";
import { draftEmail } from "../draft";
import type { GeminiToolFunction } from "../../ai/geminiClient";
import type { PersonaVertical } from "../registry";

const PERSONA = "sales";

// ─── Types ──────────────────────────────────────────────────────────────────
export type DealStage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";

export interface SalesContact {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  title: string | null;
  phone: string | null;
  notes: string | null;
  source: string;
  createdAt: Date;
}

export interface SalesDeal {
  id: string;
  title: string;
  contactName: string | null;
  company: string | null;
  amountCents: number;
  currency: string;
  stage: DealStage;
  closeDate: string | null;
  notes: string | null;
  source: string;
  createdAt: Date;
}

// ─── Contacts CRUD ──────────────────────────────────────────────────────────
export async function listContacts(userId: string): Promise<SalesContact[]> {
  const res = await query(
    `SELECT id, name, email, company, title, phone, notes, source, created_at
       FROM sales_contacts WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows.map(mapContact as never);
}

export async function createContact(
  userId: string,
  data: { name: string; email?: string; company?: string; title?: string; phone?: string; notes?: string; source?: string },
): Promise<SalesContact> {
  const res = await query(
    `INSERT INTO sales_contacts (user_id, name, email, company, title, phone, notes, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, name, email, company, title, phone, notes, source, created_at`,
    [userId, data.name, data.email ?? null, data.company ?? null, data.title ?? null, data.phone ?? null, data.notes ?? null, data.source ?? "manual"],
  );
  return mapContact(res.rows[0] as never);
}

// ─── Deals CRUD ─────────────────────────────────────────────────────────────
export async function listDeals(userId: string): Promise<SalesDeal[]> {
  const res = await query(
    `SELECT id, title, contact_name, company, amount_cents, currency, stage, close_date, notes, source, created_at
       FROM sales_deals WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows.map(mapDeal as never);
}

export async function createDeal(
  userId: string,
  data: { title: string; contactName?: string; company?: string; amountCents?: number; currency?: string; stage?: DealStage; closeDate?: string; notes?: string; source?: string },
): Promise<SalesDeal> {
  const res = await query(
    `INSERT INTO sales_deals (user_id, title, contact_name, company, amount_cents, currency, stage, close_date, notes, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, title, contact_name, company, amount_cents, currency, stage, close_date, notes, source, created_at`,
    [userId, data.title, data.contactName ?? null, data.company ?? null, data.amountCents ?? 0, data.currency ?? "USD", data.stage ?? "lead", data.closeDate ?? null, data.notes ?? null, data.source ?? "manual"],
  );
  return mapDeal(res.rows[0] as never);
}

export async function updateDeal(
  userId: string,
  id: string,
  patch: { stage?: DealStage; amountCents?: number; notes?: string },
): Promise<SalesDeal | null> {
  const res = await query(
    `UPDATE sales_deals SET
        stage       = COALESCE($3, stage),
        amount_cents= COALESCE($4, amount_cents),
        notes       = COALESCE($5, notes),
        updated_at  = now()
      WHERE id = $1 AND user_id = $2
      RETURNING id, title, contact_name, company, amount_cents, currency, stage, close_date, notes, source, created_at`,
    [id, userId, patch.stage ?? null, patch.amountCents ?? null, patch.notes ?? null],
  );
  return res.rows[0] ? mapDeal(res.rows[0] as never) : null;
}

// ─── Demo seed ──────────────────────────────────────────────────────────────
export async function seedDemo(userId: string): Promise<{ count: number }> {
  const existing = await query<{ n: string }>(`SELECT COUNT(*) n FROM sales_deals WHERE user_id = $1`, [userId]);
  if (parseInt(existing.rows[0]?.n ?? "0", 10) > 0) {
    return { count: 0 };
  }
  const contacts = [
    { name: "Dana Lee", email: "dana@acme.io", company: "Acme Corp", title: "VP Sales" },
    { name: "Sam Rivera", email: "sam@globex.com", company: "Globex LLC", title: "Head of Ops" },
    { name: "Priya Shah", email: "priya@initech.com", company: "Initech", title: "CTO" },
  ];
  for (const c of contacts) await createContact(userId, { ...c, source: "demo" });
  const deals: { title: string; contactName: string; company: string; amountCents: number; stage: DealStage }[] = [
    { title: "Acme — annual platform", contactName: "Dana Lee", company: "Acme Corp", amountCents: 4800000, stage: "proposal" },
    { title: "Globex — pilot expansion", contactName: "Sam Rivera", company: "Globex LLC", amountCents: 1200000, stage: "negotiation" },
    { title: "Initech — new logo", contactName: "Priya Shah", company: "Initech", amountCents: 2600000, stage: "qualified" },
    { title: "Umbrella — renewal", contactName: "", company: "Umbrella Inc", amountCents: 900000, stage: "lead" },
  ];
  for (const d of deals) await createDeal(userId, { ...d, source: "demo" });
  return { count: deals.length };
}

// ─── AI snapshot ────────────────────────────────────────────────────────────
async function buildSnapshot(userId: string): Promise<string> {
  const [deals, contacts] = await Promise.all([listDeals(userId), listContacts(userId)]);
  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const pipelineValue = open.reduce((s, d) => s + d.amountCents, 0);
  const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US")}`;
  return [
    `Open pipeline: ${fmt(pipelineValue)} across ${open.length} deal(s). Contacts: ${contacts.length}.`,
    "Deals:",
    ...deals
      .slice(0, 20)
      .map((d) => `- ${d.title} | ${d.company ?? "—"} | ${fmt(d.amountCents)} | stage=${d.stage} | contact=${d.contactName ?? "—"}`),
    "Contacts:",
    ...contacts.slice(0, 20).map((c) => `- ${c.name} | ${c.company ?? "—"} | ${c.email ?? "no-email"} | ${c.title ?? ""}`),
  ].join("\n");
}

// ─── Agent tools ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = [
  "You are the user's AI sales & marketing assistant inside the Interlink app.",
  "Answer questions about the pipeline/contacts using ONLY the DATA SNAPSHOT, or perform ONE action by calling a function when the user clearly asks.",
  "Never invent contacts, companies, or numbers not in the snapshot. Resolve a person/company from the snapshot when you can.",
  "You never send anything yourself — the app asks the user to confirm before executing.",
].join("\n");

const TOOLS: GeminiToolFunction[] = [
  {
    name: "create_contact",
    description: "Add a new sales contact/prospect.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        company: { type: "string" },
        title: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_deal",
    description: "Create a new deal/opportunity in the pipeline.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short deal name." },
        contactName: { type: "string" },
        company: { type: "string" },
        amountCents: { type: "number", description: "Deal value in cents." },
        stage: { type: "string", enum: ["lead", "qualified", "proposal", "negotiation", "won", "lost"] },
      },
      required: ["title"],
    },
  },
  {
    name: "advance_stage",
    description: "Move a deal to a new pipeline stage.",
    parameters: {
      type: "object",
      properties: {
        dealTitle: { type: "string", description: "Deal name from the snapshot." },
        stage: { type: "string", enum: ["lead", "qualified", "proposal", "negotiation", "won", "lost"] },
      },
      required: ["dealTitle", "stage"],
    },
  },
  {
    name: "draft_followup",
    description: "Draft and send a personalized follow-up email to a contact.",
    parameters: {
      type: "object",
      properties: {
        contactName: { type: "string", description: "Contact name from the snapshot." },
        note: { type: "string", description: "Optional context for the follow-up." },
      },
      required: ["contactName"],
    },
  },
  {
    name: "draft_campaign",
    description: "Draft a marketing campaign/newsletter email (returns the copy for review; does not send).",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string" },
        audience: { type: "string" },
      },
      required: ["topic"],
    },
  },
  {
    name: "log_activity",
    description: "Log a note/activity to the feed.",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  },
];

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "create_contact": return `Add contact ${args.name ?? ""}${args.company ? ` (${args.company})` : ""}.`;
    case "create_deal": return `Create deal "${args.title ?? ""}"${args.company ? ` for ${args.company}` : ""}.`;
    case "advance_stage": return `Move "${args.dealTitle ?? "deal"}" to ${args.stage}.`;
    case "draft_followup": return `Draft & send a follow-up to ${args.contactName ?? "the contact"}.`;
    case "draft_campaign": return `Draft a campaign email about ${args.topic ?? "your product"}.`;
    case "log_activity": return `Log: ${args.note ?? ""}`;
    default: return `Run ${name}.`;
  }
}

async function executeTool(
  user: AppUser,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  try {
    switch (name) {
      case "create_contact": {
        const c = await createContact(user.id, {
          name: String(args.name ?? "").trim(),
          email: args.email ? String(args.email) : undefined,
          company: args.company ? String(args.company) : undefined,
          title: args.title ? String(args.title) : undefined,
          source: "assistant",
        });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "contact_created", title: `Added contact ${c.name}`, entityType: "sales_contact", entityId: c.id });
        return { ok: true, message: `Added ${c.name}.` };
      }
      case "create_deal": {
        const d = await createDeal(user.id, {
          title: String(args.title ?? "").trim(),
          contactName: args.contactName ? String(args.contactName) : undefined,
          company: args.company ? String(args.company) : undefined,
          amountCents: typeof args.amountCents === "number" ? args.amountCents : undefined,
          stage: args.stage as DealStage | undefined,
          source: "assistant",
        });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "deal_created", title: `Created deal ${d.title}`, entityType: "sales_deal", entityId: d.id });
        return { ok: true, message: `Created deal "${d.title}".` };
      }
      case "advance_stage": {
        const deals = await listDeals(user.id);
        const match = deals.find((d) => d.title.toLowerCase() === String(args.dealTitle ?? "").toLowerCase());
        if (!match) return { ok: false, message: "Couldn't find that deal." };
        await updateDeal(user.id, match.id, { stage: args.stage as DealStage });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "deal_advanced", title: `${match.title} → ${args.stage}`, entityType: "sales_deal", entityId: match.id });
        return { ok: true, message: `Moved "${match.title}" to ${args.stage}.` };
      }
      case "draft_followup": {
        const contacts = await listContacts(user.id);
        const c = contacts.find((x) => x.name.toLowerCase() === String(args.contactName ?? "").toLowerCase());
        if (!c) return { ok: false, message: "Couldn't find that contact." };
        if (!c.email) return { ok: false, message: `No email on file for ${c.name}.` };
        const draft = await draftEmail({
          role: "sales representative",
          purpose: "a warm, concise follow-up email to a prospect",
          context: `Contact: ${c.name}${c.company ? `, ${c.company}` : ""}${c.title ? `, ${c.title}` : ""}. ${args.note ? `Note: ${args.note}` : ""}`,
        });
        await sendProfessionalEmail({ user, to: c.email, subject: draft.subject, body: draft.body, tag: "sales_followup" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "followup_sent", title: `Follow-up sent to ${c.name}`, detail: draft.subject, entityType: "sales_contact", entityId: c.id });
        return { ok: true, message: `Follow-up sent to ${c.name}.` };
      }
      case "draft_campaign": {
        const draft = await draftEmail({
          role: "marketing manager",
          purpose: "a short marketing campaign email",
          context: `Topic: ${args.topic ?? ""}. Audience: ${args.audience ?? "prospects"}.`,
        });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "campaign_drafted", title: `Drafted campaign: ${draft.subject}` });
        return { ok: true, message: `Draft ready — Subject: ${draft.subject}\n\n${draft.body}` };
      }
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
  id: string; name: string; email: string | null; company: string | null; title: string | null; phone: string | null; notes: string | null; source: string; created_at: Date;
}): SalesContact {
  return { id: r.id, name: r.name, email: r.email, company: r.company, title: r.title, phone: r.phone, notes: r.notes, source: r.source, createdAt: r.created_at };
}
function mapDeal(r: {
  id: string; title: string; contact_name: string | null; company: string | null; amount_cents: string | number; currency: string; stage: DealStage; close_date: string | null; notes: string | null; source: string; created_at: Date;
}): SalesDeal {
  return {
    id: r.id, title: r.title, contactName: r.contact_name, company: r.company,
    amountCents: typeof r.amount_cents === "string" ? parseInt(r.amount_cents, 10) : r.amount_cents,
    currency: r.currency, stage: r.stage, closeDate: r.close_date, notes: r.notes, source: r.source, createdAt: r.created_at,
  };
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
};
