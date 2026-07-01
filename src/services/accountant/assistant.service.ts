/**
 * "Ask your AI accountant" assistant service (Professional Mode).
 *
 * Builds a compact snapshot of the user's AR + expenses (tool-less RAG), asks
 * Gemini to answer grounded in it, and persists the conversation for memory.
 */

import { createHash, randomUUID } from "crypto";
import { query } from "../../config/db";
import { generateAssistantReply } from "../ai/ai.service";
import type { AssistantReply, AssistantChatTurn } from "../ai/prompts/assistant";
import { listInvoices } from "./invoices.service";
import { listExpenses } from "./expenses.service";
import { planAgentActions, planPersonaReply } from "../ai/multimodal.service";
import { getVertical } from "../professional/registry";
import { summarizeAction, isMoneyAdjacent } from "../ai/prompts/agentTools";
import { bulkSendReminders, sendInvoiceReminder } from "./dunning.service";
import { runExpenseAudit } from "./expenses.service";
import { emailFlashReport } from "./reporting.service";
import {
  setClientDunningPaused,
  updateAutomation,
  type AutomationType,
  type AutonomyLevel,
} from "./automations.service";
import { recordActivity } from "./activity.service";
import { AppUser } from "../../types";

function daysOverdue(due: string): number {
  const d = new Date(`${due}T00:00:00`).getTime();
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.round((Date.now() - d) / 86_400_000));
}

async function buildSnapshot(userId: string): Promise<string> {
  const invoices = await listInvoices(userId);
  const expenses = await listExpenses(userId);
  const currency = invoices[0]?.currency ?? "USD";

  const active = invoices.filter((i) => i.status !== "paid");
  const overdue = active
    .filter((i) => daysOverdue(i.dueDate) > 0)
    .sort((a, b) => b.amountCents - a.amountCents);
  const outstanding = active.reduce((s, i) => s + i.amountCents, 0);
  const flagged = expenses.filter((e) => e.status === "flagged");

  const fmt = (c: number) => `${(c / 100).toFixed(2)} ${currency}`;

  return [
    `Outstanding receivables: ${fmt(outstanding)} across ${active.length} invoice(s); ${overdue.length} overdue.`,
    "Overdue invoices:",
    ...overdue
      .slice(0, 12)
      .map(
        (i) =>
          `- ${i.clientName} | ${i.invoiceNumber} | ${fmt(i.amountCents)} | due ${i.dueDate} | ${daysOverdue(i.dueDate)}d overdue | reminders ${i.reminderCount}`,
      ),
    `Expenses: ${expenses.length} total, ${flagged.length} flagged.`,
    ...flagged
      .slice(0, 8)
      .map((e) => `- FLAGGED ${e.merchant} ${fmt(e.amountCents)} — ${e.flagReason ?? "review"}`),
  ].join("\n");
}

export interface AssistantChatResult {
  answer: string;
  suggestedActions: AssistantReply["suggestedActions"];
  isFallback: boolean;
}

export async function chat(
  userId: string,
  message: string,
  history?: AssistantChatTurn[],
): Promise<AssistantChatResult> {
  const snapshot = await buildSnapshot(userId);

  // Prefer client-supplied history; otherwise load the last turns from DB.
  let turns: AssistantChatTurn[] = history ?? [];
  if (turns.length === 0) {
    const res = await query<{ role: "user" | "assistant"; content: string }>(
      `SELECT role, content FROM accountant_chat_messages
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 8`,
      [userId],
    );
    turns = res.rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  }

  const keyHash = createHash("sha256")
    .update(message + "|" + turns.map((t) => t.content).join("|"))
    .digest("hex")
    .slice(0, 16);

  const result = await generateAssistantReply({
    userId,
    idempotencyKey: `ai:assistant:${userId}:${keyHash}`,
    context: { dataSnapshot: snapshot, history: turns, message },
  });

  // Persist the turn (best-effort).
  await query(
    `INSERT INTO accountant_chat_messages (user_id, role, content)
     VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
    [userId, message, result.data.answer],
  ).catch(() => {});

  return {
    answer: result.data.answer,
    suggestedActions: result.data.suggestedActions,
    isFallback: result.isFallback,
  };
}

export async function getChatHistory(
  userId: string,
  limit = 40,
): Promise<{ role: "user" | "assistant"; content: string; createdAt: Date }[]> {
  const res = await query<{ role: "user" | "assistant"; content: string; created_at: Date }>(
    `SELECT role, content, created_at FROM accountant_chat_messages
      WHERE user_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [userId, limit],
  );
  return res.rows.map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }));
}

// ─── Agentic command center (function-calling) ────────────────────────────────

export interface PendingAction {
  id: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
  needsConfirm: boolean;
}

export interface CommandResult {
  answer: string | null;
  action: PendingAction | null;
  isLive: boolean;
  conversationId: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: Date;
}

/** Derive a short title from the first user message of a conversation. */
function titleFromMessage(message: string): string {
  const clean = message.trim().replace(/\s+/g, " ");
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean || "New chat";
}

/**
 * Resolve the conversation to write into. When `conversationId` is missing (or
 * doesn't belong to the user) a fresh conversation is created and titled from
 * the opening message, so the app's history list stays per-thread.
 */
async function ensureConversation(
  userId: string,
  conversationId: string | undefined,
  firstMessage: string,
): Promise<string> {
  if (conversationId) {
    const owned = await query<{ id: string }>(
      `SELECT id FROM accountant_conversations WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [conversationId, userId],
    );
    if (owned.rows[0]) return owned.rows[0].id;
  }
  const created = await query<{ id: string }>(
    `INSERT INTO accountant_conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
    [userId, titleFromMessage(firstMessage)],
  );
  return created.rows[0].id;
}

/** List a user's conversations, most recently active first. */
export async function listConversations(
  userId: string,
): Promise<ConversationSummary[]> {
  const res = await query<{ id: string; title: string; updated_at: Date }>(
    `SELECT id, title, updated_at FROM accountant_conversations
      WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
    [userId],
  );
  return res.rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
}

/** Fetch the messages of one conversation (oldest first), scoped to the user. */
export async function getConversationMessages(
  userId: string,
  conversationId: string,
): Promise<{ role: "user" | "assistant"; content: string; createdAt: Date }[]> {
  const res = await query<{ role: "user" | "assistant"; content: string; created_at: Date }>(
    `SELECT m.role, m.content, m.created_at
       FROM accountant_chat_messages m
       JOIN accountant_conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1 AND c.user_id = $2
      ORDER BY m.created_at ASC`,
    [conversationId, userId],
  );
  return res.rows.map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }));
}

/** A user's Professional-Mode persona (defaults to finance). */
const PERSONA_LABELS: Record<string, string> = {
  finance: "Finance / Accountant",
  product_manager: "Product Manager",
  hr: "HR",
  sales: "Sales",
  marketing: "Marketing",
  legal: "Legal",
  real_estate: "Real Estate",
  healthcare: "Healthcare",
  operations: "Operations",
  recruiter: "Recruiter",
  customer_support: "Customer Support",
};

async function getProfessionalPersona(userId: string): Promise<string> {
  const res = await query<{ persona: string }>(
    `SELECT persona FROM profession_profiles WHERE user_id = $1 AND mode = 'professional' LIMIT 1`,
    [userId],
  );
  return res.rows[0]?.persona ?? "finance";
}

/** The last few turns of a conversation, oldest-first — gives the agent memory. */
async function loadRecentHistory(
  convId: string,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const res = await query<{ role: "user" | "assistant"; content: string }>(
    `SELECT role, content FROM accountant_chat_messages
      WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 8`,
    [convId],
  );
  return res.rows.reverse();
}

/** Run one agentic command: returns an answer and/or a proposed action to confirm. */
export async function command(
  userId: string,
  message: string,
  conversationId?: string,
  attachment?: { data: string; mimeType: string },
): Promise<CommandResult> {
  const convId = await ensureConversation(userId, conversationId, message);
  const persona = await getProfessionalPersona(userId);

  // Non-finance roles are served by their persona vertical: agentic tools +
  // data snapshot when one is registered, else a plain domain-expert reply.
  if (persona !== "finance") {
    const vertical = getVertical(persona);
    if (vertical) {
      const snapshot = await vertical.buildSnapshot(userId);
      const history = await loadRecentHistory(convId);
      const plan = await planAgentActions({
        message,
        snapshot,
        tools: vertical.tools,
        system: vertical.systemPrompt,
        attachment,
        history,
      });
      let vAction: PendingAction | null = null;
      if (plan.action) {
        vAction = {
          id: randomUUID(),
          name: plan.action.name,
          args: plan.action.args,
          summary: vertical.summarizeAction(plan.action.name, plan.action.args),
          needsConfirm: true,
        };
      }
      const vText = vAction ? vAction.summary : (plan.answer ?? "");
      await query(
        `INSERT INTO accountant_chat_messages (user_id, role, content, conversation_id)
         VALUES ($1, 'user', $2, $4), ($1, 'assistant', $3, $4)`,
        [userId, message, vText, convId],
      ).catch(() => {});
      await query(`UPDATE accountant_conversations SET updated_at = now() WHERE id = $1`, [convId]).catch(() => {});
      return { answer: plan.answer ?? null, action: vAction, isLive: plan.isLive, conversationId: convId };
    }

    const histRes = await query<{ role: "user" | "assistant"; content: string }>(
      `SELECT role, content FROM accountant_chat_messages
        WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 6`,
      [convId],
    );
    const reply = await planPersonaReply({
      personaLabel: PERSONA_LABELS[persona] ?? persona,
      message,
      history: histRes.rows.reverse(),
    });
    await query(
      `INSERT INTO accountant_chat_messages (user_id, role, content, conversation_id)
       VALUES ($1, 'user', $2, $4), ($1, 'assistant', $3, $4)`,
      [userId, message, reply.answer, convId],
    ).catch(() => {});
    await query(
      `UPDATE accountant_conversations SET updated_at = now() WHERE id = $1`,
      [convId],
    ).catch(() => {});
    return { answer: reply.answer, action: null, isLive: reply.isLive, conversationId: convId };
  }

  const snapshot = await buildSnapshot(userId);
  const financeHistory = await loadRecentHistory(convId);
  const plan = await planAgentActions({ message, snapshot, attachment, history: financeHistory });

  let action: PendingAction | null = null;
  if (plan.action) {
    action = {
      id: randomUUID(),
      name: plan.action.name,
      args: plan.action.args,
      summary: summarizeAction(plan.action.name, plan.action.args),
      needsConfirm: true,
    };
  }

  // Persist the turn + bump conversation recency (best-effort).
  const assistantText = action ? action.summary : (plan.answer ?? "");
  await query(
    `INSERT INTO accountant_chat_messages (user_id, role, content, conversation_id)
     VALUES ($1, 'user', $2, $4), ($1, 'assistant', $3, $4)`,
    [userId, message, assistantText, convId],
  ).catch(() => {});
  await query(
    `UPDATE accountant_conversations SET updated_at = now() WHERE id = $1`,
    [convId],
  ).catch(() => {});

  return { answer: plan.answer ?? null, action, isLive: plan.isLive, conversationId: convId };
}

/** Execute a user-confirmed agent action via the existing services. */
export async function executeAction(
  user: AppUser,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  // Non-finance personas dispatch to their vertical's tool executor.
  const persona = await getProfessionalPersona(user.id);
  if (persona !== "finance") {
    const vertical = getVertical(persona);
    if (vertical) return vertical.executeTool(user, name, args);
    return { ok: false, message: `No actions available for this role.` };
  }
  try {
    switch (name) {
      case "send_reminder": {
        let invoiceId = String(args.invoiceId ?? "");
        if (!invoiceId && args.clientName) {
          const match = (await listInvoices(user.id)).find(
            (i) =>
              i.status !== "paid" &&
              i.clientName.toLowerCase() === String(args.clientName).toLowerCase(),
          );
          invoiceId = match?.id ?? "";
        }
        if (!invoiceId) return { ok: false, message: "Couldn't find that invoice." };
        const tone = args.tone as "friendly" | "firm" | "final" | undefined;
        const res = await sendInvoiceReminder({ user, invoiceId, escalationTone: tone });
        await recordActivity({
          userId: user.id,
          kind: "reminder_sent",
          title: `Reminder sent to ${res.recipients.join(", ")}`,
          detail: "via AI command",
          entityType: "invoice",
          entityId: invoiceId,
          status: "done",
        });
        return { ok: true, message: "Reminder sent." };
      }
      case "remind_all_overdue": {
        const overdue = (await listInvoices(user.id)).filter(
          (i) => i.status === "overdue" || i.status === "reminded",
        );
        const outcomes = await bulkSendReminders(
          user,
          overdue.map((i) => ({ invoiceId: i.id })),
        );
        const sent = outcomes.filter((o) => o.ok).length;
        await recordActivity({
          userId: user.id,
          kind: "reminder_sent",
          title: `Sent ${sent} reminders to overdue clients`,
          detail: "via AI command",
          status: "done",
        });
        return { ok: true, message: `Sent ${sent} reminder${sent === 1 ? "" : "s"}.` };
      }
      case "run_expense_audit": {
        const r = await runExpenseAudit(user.id);
        await recordActivity({
          userId: user.id,
          kind: "audit_run",
          title: `Expense audit flagged ${r.flaggedCount} item${r.flaggedCount === 1 ? "" : "s"}`,
          status: "done",
        });
        return { ok: true, message: `Flagged ${r.flaggedCount} expense(s).` };
      }
      case "email_flash_report": {
        await emailFlashReport(user);
        await recordActivity({
          userId: user.id,
          kind: "report_emailed",
          title: "Flash report emailed to you",
          status: "done",
        });
        return { ok: true, message: "Report emailed." };
      }
      case "pause_client": {
        const clientName = String(args.clientName ?? "");
        if (!clientName) return { ok: false, message: "Which client?" };
        await setClientDunningPaused(user.id, clientName, true);
        return { ok: true, message: `Paused reminders for ${clientName}.` };
      }
      case "set_automation": {
        await updateAutomation(user.id, args.type as AutomationType, {
          autonomy: args.autonomy as AutonomyLevel,
        });
        return { ok: true, message: `Updated ${args.type} to ${args.autonomy}.` };
      }
      default:
        return { ok: false, message: `Unsupported action: ${name}.` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export { isMoneyAdjacent };
