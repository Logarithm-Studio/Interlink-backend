/**
 * Customer Support vertical (Professional Mode).
 * Ticket data model, demo seed, AI snapshot, and agentic tools.
 */

import { query } from "../../../config/db";
import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { resolveNamedRecord } from "../assistant-records.service";
import { AppError } from "../../../utils/errors";
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
  if (!data.subject.trim()) throw new AppError("Enter a ticket subject.", 400);
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
  patch: { priority?: TicketPriority; status?: TicketStatus; category?: string; expectedStatus?: TicketStatus },
): Promise<SupportTicket | null> {
  const res = await query(
    `UPDATE support_tickets SET
        priority = COALESCE($3, priority),
        status   = COALESCE($4, status),
        category = COALESCE($5, category),
        updated_at = now()
      WHERE id = $1 AND user_id = $2 AND ($6::text IS NULL OR status=$6)
      RETURNING id, subject, body, customer_name, customer_email, priority, status, category, sla_due_at, source, created_at`,
    [id, userId, patch.priority ?? null, patch.status ?? null, patch.category ?? null, patch.expectedStatus ?? null],
  );
  return res.rows[0] ? mapRow(res.rows[0] as never) : null;
}

export async function seedDemo(userId: string): Promise<{ count: number }> {
  // Reset-and-reseed for a clean demo.
  await query(`DELETE FROM support_tickets WHERE user_id = $1`, [userId]);
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
    ...tickets.slice(0, 20).map((t) => `- [${t.priority}/${t.status}] ${t.subject} | id=${t.id} | ${t.customerName ?? "—"} <${t.customerEmail ?? "no-email"}> | ${t.body ?? ""}`),
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are the user's AI customer-support assistant inside the Interlink app.",
  "Answer questions about tickets using ONLY the DATA SNAPSHOT, or perform ONE action by calling a function when asked.",
  "Never invent customers or ticket contents. You never send anything yourself — the app confirms before executing.",
].join("\n");

const TOOLS: GeminiToolFunction[] = [
  { name: "create_ticket", description: "Save a local Support ticket from actual supplied details. Does not contact the customer or create a provider-side ticket.", parameters: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" }, customerName: { type: "string" }, customerEmail: { type: "string" }, priority: { type: "string", enum: ["low", "medium", "high", "urgent"] } }, required: ["subject"] } },
  {
    name: "triage_ticket",
    description: "Set a ticket's priority and/or category.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Ticket subject from the snapshot." },
        ticketId: { type: "string", description: "Exact owned ID; preferred over subject matching." },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        category: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "draft_reply",
    description: "Prepare exact reply copy for an owned ticket. Does not send or change its status. Delivery requires a separate review of the recipient and exact copy.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Ticket subject from the snapshot." },
        ticketId: { type: "string" },
        note: { type: "string", description: "Optional guidance for the reply." },
      },
      required: [],
    },
  },
  {
    name: "escalate_ticket",
    description: "Mark a ticket as escalated.",
    parameters: { type: "object", properties: { subject: { type: "string" }, ticketId: { type: "string" } } },
  },
  {
    name: "resolve_ticket",
    description: "Mark a ticket as resolved.",
    parameters: { type: "object", properties: { subject: { type: "string" }, ticketId: { type: "string" } } },
  },
];

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "create_ticket": return `Save local Support ticket "${args.subject ?? ""}". No customer message.`;
    case "triage_ticket": return `Triage "${args.subject ?? "ticket"}"${args.priority ? ` → ${args.priority}` : ""}.`;
    case "draft_reply": return `Prepare a reply draft for "${args.subject ?? "ticket"}". No send or status change.`;
    case "escalate_ticket": return `Escalate "${args.subject ?? "ticket"}".`;
    case "resolve_ticket": return `Resolve "${args.subject ?? "ticket"}".`;
    default: return `Run ${name}.`;
  }
}

async function findTicket(userId: string, subject: string, id?: unknown): Promise<SupportTicket> {
  return resolveNamedRecord(await listTickets(userId), "subject", id, subject);
}

async function reviewSupportAction(userId: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === "create_ticket" || !TOOLS.some(tool => tool.name === name)) return args;
  const ticket = await findTicket(userId, String(args.subject ?? ""), args.ticketId);
  return { ...args, ticketId: ticket.id, subject: ticket.subject, reviewedStatus: ticket.status };
}

async function executeTool(user: AppUser, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string; data?: unknown }> {
  try {
    if (name === "create_ticket") {
      const ticket = await createTicket(user.id, { subject: String(args.subject ?? "").trim(), body: args.body ? String(args.body) : undefined, customerName: args.customerName ? String(args.customerName) : undefined, customerEmail: args.customerEmail ? String(args.customerEmail) : undefined, priority: args.priority as TicketPriority | undefined, source: "assistant" });
      return { ok: true, message: `Created local ticket "${ticket.subject}". No message was sent.`, data: ticket };
    }
    const t = await findTicket(user.id, String(args.subject ?? ""), args.ticketId);
    if (args.reviewedStatus && t.status !== args.reviewedStatus) throw new AppError("This ticket changed after review. Read it and prepare a fresh review.", 409);
    const update = async (patch: Parameters<typeof updateTicket>[2]) => {
      const saved = await updateTicket(user.id, t.id, { ...patch, expectedStatus: t.status });
      if (!saved) throw new AppError("This ticket changed after review. Prepare a fresh review.", 409);
      return saved;
    };
    switch (name) {
      case "triage_ticket":
        if (args.priority && !["low", "medium", "high", "urgent"].includes(String(args.priority))) throw new AppError("Choose a supported ticket priority.", 400);
        if (!args.priority && !args.category) throw new AppError("Choose a priority or category to change.", 400);
        await update({ priority: args.priority as TicketPriority | undefined, category: args.category ? String(args.category) : undefined });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "ticket_triaged", title: `Triaged: ${t.subject}`, entityType: "support_ticket", entityId: t.id });
        return { ok: true, message: `Triaged "${t.subject}".` };
      case "draft_reply": {
        if (!t.customerEmail) return { ok: false, message: "No customer email on this ticket." };
        const draft = await draftEmail({
          role: "customer-support agent",
          purpose: "a helpful, empathetic reply resolving the customer's issue",
          context: `Ticket: ${t.subject}. Message: ${t.body ?? ""}. ${args.note ? `Guidance: ${args.note}` : ""}`,
        });
        if (draft.isFallback || !draft.body.trim()) return { ok: false, message: "Reply copy is unavailable. Nothing was sent or changed." };
        return { ok: true, message: "Prepared a reply draft. No email or ticket-status change.", data: { ticketId: t.id, toEmail: t.customerEmail, subject: `Re: ${t.subject}`, body: draft.body, status: "draft" } };
      }
      case "escalate_ticket":
        await update({ status: "escalated" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "ticket_escalated", title: `Escalated: ${t.subject}`, entityType: "support_ticket", entityId: t.id });
        return { ok: true, message: `Escalated "${t.subject}".` };
      case "resolve_ticket":
        await update({ status: "resolved" });
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
  reviewAction: reviewSupportAction,
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
