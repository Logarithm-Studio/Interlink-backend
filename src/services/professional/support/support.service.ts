/**
 * Customer Support vertical (Professional Mode).
 * Ticket data model, demo seed, AI snapshot, and agentic tools.
 */

import { query } from "../../../config/db";
import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { sendProfessionalEmail } from "../email";
import { draftEmail } from "../draft";
import type { GeminiToolFunction } from "../../ai/geminiClient";
import type { AutomationProposal, PersonaVertical } from "../registry";

const PERSONA = "customer_support";

export type TicketPriority = "low" | "medium" | "high" | "urgent";
export type TicketStatus = "open" | "pending" | "escalated" | "resolved";

export interface SupportTicket {
  id: string;
  subject: string;
  body: string | null;
  customerName: string | null;
  customerEmail: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  category: string | null;
  slaDueAt: Date | null;
  source: string;
  createdAt: Date;
}

export async function listTickets(userId: string): Promise<SupportTicket[]> {
  const res = await query(
    `SELECT id, subject, body, customer_name, customer_email, priority, status, category, sla_due_at, source, created_at
       FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows.map(mapRow as never);
}

export async function createTicket(
  userId: string,
  data: { subject: string; body?: string; customerName?: string; customerEmail?: string; priority?: TicketPriority; category?: string; source?: string },
): Promise<SupportTicket> {
  // SLA target derived from priority so the SLA-watch automation has a deadline.
  const res = await query(
    `INSERT INTO support_tickets (user_id, subject, body, customer_name, customer_email, priority, category, source, sla_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
             now() + CASE $6
               WHEN 'urgent' THEN interval '4 hours'
               WHEN 'high'   THEN interval '8 hours'
               WHEN 'medium' THEN interval '24 hours'
               ELSE interval '72 hours' END)
     RETURNING id, subject, body, customer_name, customer_email, priority, status, category, sla_due_at, source, created_at`,
    [userId, data.subject, data.body ?? null, data.customerName ?? null, data.customerEmail ?? null, data.priority ?? "medium", data.category ?? null, data.source ?? "manual"],
  );
  return mapRow(res.rows[0] as never);
}

export async function updateTicket(
  userId: string,
  id: string,
  patch: { priority?: TicketPriority; status?: TicketStatus; category?: string },
): Promise<SupportTicket | null> {
  const res = await query(
    `UPDATE support_tickets SET
        priority = COALESCE($3, priority),
        status   = COALESCE($4, status),
        category = COALESCE($5, category),
        updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING id, subject, body, customer_name, customer_email, priority, status, category, sla_due_at, source, created_at`,
    [id, userId, patch.priority ?? null, patch.status ?? null, patch.category ?? null],
  );
  return res.rows[0] ? mapRow(res.rows[0] as never) : null;
}

export async function seedDemo(userId: string): Promise<{ count: number }> {
  const existing = await query<{ n: string }>(`SELECT COUNT(*) n FROM support_tickets WHERE user_id = $1`, [userId]);
  if (parseInt(existing.rows[0]?.n ?? "0", 10) > 0) return { count: 0 };
  const tickets: { subject: string; body: string; customerName: string; customerEmail: string; priority: TicketPriority }[] = [
    { subject: "Can't log in after password reset", body: "I reset my password but still get 'invalid credentials'.", customerName: "Jordan Blake", customerEmail: "jordan@example.com", priority: "high" },
    { subject: "Refund for duplicate charge", body: "I was billed twice this month, please refund one.", customerName: "Mia Chen", customerEmail: "mia@example.com", priority: "urgent" },
    { subject: "How do I export my data?", body: "Looking for a CSV export option.", customerName: "Leo Park", customerEmail: "leo@example.com", priority: "low" },
    { subject: "Feature request: dark mode", body: "Would love a dark theme.", customerName: "Sam Ortiz", customerEmail: "sam@example.com", priority: "low" },
  ];
  for (const t of tickets) await createTicket(userId, { ...t, source: "demo" });
  return { count: tickets.length };
}

async function buildSnapshot(userId: string): Promise<string> {
  const tickets = await listTickets(userId);
  const open = tickets.filter((t) => t.status !== "resolved");
  const byPriority = (p: TicketPriority) => open.filter((t) => t.priority === p).length;
  return [
    `Open tickets: ${open.length} (urgent ${byPriority("urgent")}, high ${byPriority("high")}). Resolved: ${tickets.length - open.length}.`,
    "Tickets:",
    ...tickets.slice(0, 20).map((t) => `- [${t.priority}/${t.status}] ${t.subject} | ${t.customerName ?? "—"} <${t.customerEmail ?? "no-email"}> | ${t.body ?? ""}`),
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are the user's AI customer-support assistant inside the Interlink app.",
  "Answer questions about tickets using ONLY the DATA SNAPSHOT, or perform ONE action by calling a function when asked.",
  "Never invent customers or ticket contents. You never send anything yourself — the app confirms before executing.",
].join("\n");

const TOOLS: GeminiToolFunction[] = [
  {
    name: "triage_ticket",
    description: "Set a ticket's priority and/or category.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Ticket subject from the snapshot." },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        category: { type: "string" },
      },
      required: ["subject"],
    },
  },
  {
    name: "draft_reply",
    description: "Draft and send a reply to the ticket's customer.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Ticket subject from the snapshot." },
        note: { type: "string", description: "Optional guidance for the reply." },
      },
      required: ["subject"],
    },
  },
  {
    name: "escalate_ticket",
    description: "Mark a ticket as escalated.",
    parameters: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] },
  },
  {
    name: "resolve_ticket",
    description: "Mark a ticket as resolved.",
    parameters: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] },
  },
];

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "triage_ticket": return `Triage "${args.subject ?? "ticket"}"${args.priority ? ` → ${args.priority}` : ""}.`;
    case "draft_reply": return `Draft & send a reply for "${args.subject ?? "ticket"}".`;
    case "escalate_ticket": return `Escalate "${args.subject ?? "ticket"}".`;
    case "resolve_ticket": return `Resolve "${args.subject ?? "ticket"}".`;
    default: return `Run ${name}.`;
  }
}

async function findTicket(userId: string, subject: string): Promise<SupportTicket | undefined> {
  const tickets = await listTickets(userId);
  const s = subject.toLowerCase();
  return tickets.find((t) => t.subject.toLowerCase() === s) ?? tickets.find((t) => t.subject.toLowerCase().includes(s));
}

async function executeTool(user: AppUser, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    const t = await findTicket(user.id, String(args.subject ?? ""));
    if (!t) return { ok: false, message: "Couldn't find that ticket." };
    switch (name) {
      case "triage_ticket":
        await updateTicket(user.id, t.id, { priority: args.priority as TicketPriority | undefined, category: args.category ? String(args.category) : undefined });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "ticket_triaged", title: `Triaged: ${t.subject}`, entityType: "support_ticket", entityId: t.id });
        return { ok: true, message: `Triaged "${t.subject}".` };
      case "draft_reply": {
        if (!t.customerEmail) return { ok: false, message: "No customer email on this ticket." };
        const draft = await draftEmail({
          role: "customer-support agent",
          purpose: "a helpful, empathetic reply resolving the customer's issue",
          context: `Ticket: ${t.subject}. Message: ${t.body ?? ""}. ${args.note ? `Guidance: ${args.note}` : ""}`,
        });
        await sendProfessionalEmail({ user, to: t.customerEmail, subject: `Re: ${t.subject}`, body: draft.body, tag: "support_reply" });
        await updateTicket(user.id, t.id, { status: "pending" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "reply_sent", title: `Replied to ${t.customerName ?? "customer"}`, detail: t.subject, entityType: "support_ticket", entityId: t.id });
        return { ok: true, message: `Reply sent to ${t.customerName ?? "customer"}.` };
      }
      case "escalate_ticket":
        await updateTicket(user.id, t.id, { status: "escalated" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "ticket_escalated", title: `Escalated: ${t.subject}`, entityType: "support_ticket", entityId: t.id });
        return { ok: true, message: `Escalated "${t.subject}".` };
      case "resolve_ticket":
        await updateTicket(user.id, t.id, { status: "resolved" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "ticket_resolved", title: `Resolved: ${t.subject}`, entityType: "support_ticket", entityId: t.id });
        return { ok: true, message: `Resolved "${t.subject}".` };
      default:
        return { ok: false, message: `Unsupported action: ${name}.` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function mapRow(r: {
  id: string; subject: string; body: string | null; customer_name: string | null; customer_email: string | null; priority: TicketPriority; status: TicketStatus; category: string | null; sla_due_at: Date | null; source: string; created_at: Date;
}): SupportTicket {
  return { id: r.id, subject: r.subject, body: r.body, customerName: r.customer_name, customerEmail: r.customer_email, priority: r.priority, status: r.status, category: r.category, slaDueAt: r.sla_due_at, source: r.source, createdAt: r.created_at };
}

async function planSlaWatch(userId: string): Promise<AutomationProposal[]> {
  const res = await query<{ id: string; subject: string }>(
    `SELECT id, subject FROM support_tickets
      WHERE user_id = $1 AND status IN ('open','pending')
        AND (priority IN ('high','urgent') OR (sla_due_at IS NOT NULL AND sla_due_at < now()))
      ORDER BY created_at ASC LIMIT 10`,
    [userId],
  );
  return res.rows.map((t) => ({
    title: `Reply to "${t.subject}"`,
    entityType: "support_ticket",
    entityId: t.id,
    tool: "draft_reply",
    args: { subject: t.subject },
  }));
}

export const supportVertical: PersonaVertical = {
  persona: PERSONA,
  tools: TOOLS,
  systemPrompt: SYSTEM_PROMPT,
  buildSnapshot,
  executeTool,
  summarizeAction,
  seedDemo,
  automations: [
    {
      type: "sla_watch",
      title: "SLA breach alarm",
      description: "Reply to urgent / SLA-breaching tickets before they age",
      cadenceDays: 1,
      defaultAutonomy: "suggest",
      plan: planSlaWatch,
    },
  ],
};
