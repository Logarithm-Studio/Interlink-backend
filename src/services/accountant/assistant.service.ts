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
import { listInvoices, createInvoice, type Invoice } from "./invoices.service";
import { listExpenses } from "./expenses.service";
import { planAgentActions, planPersonaReply } from "../ai/multimodal.service";
import { getVertical } from "../professional/registry";
import { AGENT_SYSTEM, AGENT_TOOLS, summarizeAction, isMoneyAdjacent } from "../ai/prompts/agentTools";
import {
  CONNECTED_APP_ORCHESTRATION_PROMPT,
  GLOBAL_AGENT_RULES,
  connectedAppsSummary,
  executeAction as executePersonalAction,
  isReadOnlyAction as isReadOnlyPersonalAction,
  mentionsMissingAttachment,
  PERSONAL_TOOLS,
  summarizeAction as summarizePersonalAction,
} from "../personal-assistant/personal-assistant.service";
import {
  getComposioToolsForUser,
  executeComposioTool,
  isComposioToolName,
  summarizeComposioAction,
} from "../composio/composio.service";
import { bulkSendReminders, sendInvoiceReminder } from "./dunning.service";
import { runExpenseAudit } from "./expenses.service";
import { emailFlashReport } from "./reporting.service";
import { listContractors, needsW9, sendW9Request } from "./tax.service";
import {
  buildAdvisorSnapshot,
  prepareMeetingPacket,
  sendClientCommunication,
  resolveCompliance,
  type ComplianceType,
} from "./advisor.service";
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

/**
 * Roll invoices up per client so the agent can answer about ANY client — not just the
 * ones with an overdue invoice. Before this, a client whose invoices were all paid or
 * merely open (e.g. "Acme Corp" with a current invoice) was invisible to the agent, which
 * then truthfully but unhelpfully said it couldn't find them.
 */
interface ClientLedger {
  name: string;
  email: string;
  invoiceCount: number;
  outstandingCents: number;
  openCount: number;
  overdueCents: number;
  overdueCount: number;
  paidCents: number;
  paidCount: number;
}

function buildClientLedgers(invoices: Invoice[]): ClientLedger[] {
  const byClient = new Map<string, ClientLedger>();
  for (const inv of invoices) {
    const key = inv.clientName.trim().toLowerCase();
    if (!key) continue;
    const entry =
      byClient.get(key) ??
      { name: inv.clientName.trim(), email: inv.clientEmail || "", invoiceCount: 0, outstandingCents: 0, openCount: 0, overdueCents: 0, overdueCount: 0, paidCents: 0, paidCount: 0 };
    entry.invoiceCount += 1;
    if (!entry.email && inv.clientEmail) entry.email = inv.clientEmail;
    if (inv.status === "paid") {
      entry.paidCents += inv.amountCents;
      entry.paidCount += 1;
    } else {
      entry.outstandingCents += inv.amountCents;
      entry.openCount += 1;
      if (daysOverdue(inv.dueDate) > 0) {
        entry.overdueCents += inv.amountCents;
        entry.overdueCount += 1;
      }
    }
    byClient.set(key, entry);
  }
  // Most commercially relevant first: biggest outstanding, then biggest lifetime billing.
  return [...byClient.values()].sort(
    (a, b) => b.outstandingCents - a.outstandingCents || b.paidCents - a.paidCents,
  );
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

  const ledgers = buildClientLedgers(invoices);

  // Advisory book (portfolios + compliance) grounds the Financial Advisor persona so it
  // can ANSWER portfolio/compliance questions without a tool round-trip.
  const advisory = await buildAdvisorSnapshot(userId).catch(() => "");

  return [
    `Outstanding receivables: ${fmt(outstanding)} across ${active.length} invoice(s); ${overdue.length} overdue.`,
    // Full client roster/ledger — every client the user has, so the agent can answer
    // "what does <client> owe / what's their history" for anyone, not only overdue ones.
    `Client ledger (${ledgers.length} client(s) — every client with any invoice):`,
    ...ledgers
      .slice(0, 40)
      .map(
        (c) =>
          `- ${c.name} | outstanding ${fmt(c.outstandingCents)} (${c.openCount} open, ${c.overdueCount} overdue${
            c.overdueCents ? `, ${fmt(c.overdueCents)} overdue` : ""
          }) | lifetime paid ${fmt(c.paidCents)} across ${c.paidCount} | ${c.invoiceCount} invoice(s) total${
            c.email ? ` | ${c.email}` : " | no email on file"
          }`,
      ),
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
    ...(advisory ? ["", advisory] : []),
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

/** Delete a conversation and its messages (messages cascade). Scoped to the user. */
export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  await query(`DELETE FROM accountant_conversations WHERE id = $1 AND user_id = $2`, [conversationId, userId]);
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
  finance: "Financial Advisor",
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

const PERSONAL_TOOL_NAMES = new Set(PERSONAL_TOOLS.map((tool) => tool.name));

// Advertised to the professional agent so it knows the full personal-tool surface it
// inherits (these are merged in via professionalToolsWithPersonal). Keep in sync with
// PERSONAL_TOOLS capabilities.
const PERSONAL_TOOLS_NOTE = [
  "You ALSO have the user's full personal assistant toolkit — use it whenever the work calls for it:",
  "- Email via Gmail to one OR many recipients (send_gmail), and resolve people by name to their address first with search_contacts.",
  "- Schedule Google Meet meetings and invite multiple attendees at once; manage Google Calendar, Tasks, Drive (find/upload/share/delete one or many files), Notion, Todoist, Trello, Jira, GitHub.",
  "- Message teams and people on Slack: post_slack_message for channels, send_slack_dm to reach a person's inbox by name.",
  "- YouTube / YouTube Music, weather, and fitness for lighter requests.",
  "- Any app the user connected via Composio (HubSpot, Salesforce, Stripe, Zendesk, Linear, Zoom, …) appears",
  "  as an UPPER_SNAKE tool prefixed with the app name (e.g. HUBSPOT_CREATE_CONTACT). Only the apps named on the",
  "  'Connected apps' line are actually available — use them for CRM, billing, ticketing and issue-tracker work.",
].join("\n");

/**
 * The tool surface for a professional persona: its own tools + the personal toolkit +
 * whatever Composio toolkits the user connected. Every persona (finance and all five
 * verticals) goes through here, so connecting HubSpot once lights it up everywhere.
 */
async function professionalToolsWithPersonal(
  userId: string,
  tools: typeof PERSONAL_TOOLS,
): Promise<typeof PERSONAL_TOOLS> {
  const composioTools = await getComposioToolsForUser(userId);
  const seen = new Set<string>();
  return [...tools, ...PERSONAL_TOOLS, ...composioTools].filter((tool) => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

function summarizeProfessionalAction(
  name: string,
  args: Record<string, unknown>,
  verticalSummary?: (name: string, args: Record<string, unknown>) => string,
): string {
  if (isComposioToolName(name)) return summarizeComposioAction(name, args);
  if (PERSONAL_TOOL_NAMES.has(name)) return summarizePersonalAction(name, args);
  return verticalSummary ? verticalSummary(name, args) : summarizeAction(name, args);
}

async function withConnectedApps(userId: string, snapshot: string): Promise<string> {
  return `${await connectedAppsSummary(userId)}\n${snapshot}`;
}

/** The last few turns of a conversation, oldest-first — gives the agent memory. */
function actionErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return fallback;
}

async function runReadOnlyPersonalAction(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ message: string }> {
  try {
    return await executePersonalAction(userId, name, args);
  } catch (err) {
    return {
      message: actionErrorMessage(err, "I could not load that connected-app information right now."),
    };
  }
}

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

  // Hard guard: never let the model invent the contents of an attachment that wasn't sent
  // (verified live — a prompt rule alone does not stop Gemini fabricating a document).
  if (mentionsMissingAttachment(message, Boolean(attachment))) {
    const answer =
      "I don't see an attachment on that message — nothing came through.\n\n" +
      "Tap the **+** button to attach the file or photo, then send it again. I'd rather ask than invent its contents.";
    await query(
      `INSERT INTO accountant_chat_messages (user_id, role, content, conversation_id)
       VALUES ($1, 'user', $2, $4), ($1, 'assistant', $3, $4)`,
      [userId, message, answer, convId],
    ).catch(() => {});
    return { answer, action: null, isLive: true, conversationId: convId };
  }

  const persona = await getProfessionalPersona(userId);

  // Non-finance roles are served by their persona vertical: agentic tools +
  // data snapshot when one is registered, else a plain domain-expert reply.
  if (persona !== "finance") {
    const vertical = getVertical(persona);
    if (vertical) {
      const snapshot = await withConnectedApps(userId, await vertical.buildSnapshot(userId));
      const history = await loadRecentHistory(convId);
      const plan = await planAgentActions({
        message,
        snapshot,
        tools: await professionalToolsWithPersonal(userId, vertical.tools),
        system: `${vertical.systemPrompt}\n${PERSONAL_TOOLS_NOTE}\n${CONNECTED_APP_ORCHESTRATION_PROMPT}\n\n${GLOBAL_AGENT_RULES}`,
        attachment,
        history,
        isReadOnly: isReadOnlyPersonalAction,
        execReadOnly: (name, args) => runReadOnlyPersonalAction(userId, name, args),
      });
      let vAction: PendingAction | null = null;
      if (plan.action) {
        if (isReadOnlyPersonalAction(plan.action.name)) {
          const exec = await runReadOnlyPersonalAction(userId, plan.action.name, plan.action.args);
          await query(
            `INSERT INTO accountant_chat_messages (user_id, role, content, conversation_id)
             VALUES ($1, 'user', $2, $4), ($1, 'assistant', $3, $4)`,
            [userId, message, exec.message, convId],
          ).catch(() => {});
          await query(`UPDATE accountant_conversations SET updated_at = now() WHERE id = $1`, [convId]).catch(() => {});
          return { answer: exec.message, action: null, isLive: plan.isLive, conversationId: convId };
        }
        vAction = {
          id: randomUUID(),
          name: plan.action.name,
          args: plan.action.args,
          summary: summarizeProfessionalAction(plan.action.name, plan.action.args, vertical.summarizeAction),
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

  const snapshot = await withConnectedApps(userId, await buildSnapshot(userId));
  const financeHistory = await loadRecentHistory(convId);
  const plan = await planAgentActions({
    message,
    snapshot,
    tools: await professionalToolsWithPersonal(userId, AGENT_TOOLS),
    system: `${AGENT_SYSTEM}\n${PERSONAL_TOOLS_NOTE}\n${CONNECTED_APP_ORCHESTRATION_PROMPT}\n\n${GLOBAL_AGENT_RULES}`,
    attachment,
    history: financeHistory,
    isReadOnly: isReadOnlyPersonalAction,
    execReadOnly: (name, args) => runReadOnlyPersonalAction(userId, name, args),
  });

  let action: PendingAction | null = null;
  if (plan.action) {
    if (isReadOnlyPersonalAction(plan.action.name)) {
      const exec = await runReadOnlyPersonalAction(userId, plan.action.name, plan.action.args);
      await query(
        `INSERT INTO accountant_chat_messages (user_id, role, content, conversation_id)
         VALUES ($1, 'user', $2, $4), ($1, 'assistant', $3, $4)`,
        [userId, message, exec.message, convId],
      ).catch(() => {});
      await query(`UPDATE accountant_conversations SET updated_at = now() WHERE id = $1`, [convId]).catch(() => {});
      return { answer: exec.message, action: null, isLive: plan.isLive, conversationId: convId };
    }
    action = {
      id: randomUUID(),
      name: plan.action.name,
      args: plan.action.args,
      summary: summarizeProfessionalAction(plan.action.name, plan.action.args),
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
  // Composio-brokered tools are persona-agnostic — a connected HubSpot works the same for
  // finance and every vertical — so dispatch them before the persona branch.
  if (isComposioToolName(name)) return executeComposioTool(user.id, name, args);

  // Non-finance personas dispatch to their vertical's tool executor.
  const persona = await getProfessionalPersona(user.id);
  if (persona !== "finance") {
    if (PERSONAL_TOOL_NAMES.has(name)) return executePersonalAction(user.id, name, args);
    const vertical = getVertical(persona);
    if (vertical) return vertical.executeTool(user, name, args);
    return { ok: false, message: `No actions available for this role.` };
  }
  try {
    if (PERSONAL_TOOL_NAMES.has(name)) return executePersonalAction(user.id, name, args);
    switch (name) {
      case "create_invoice": {
        const clientName = String(args.clientName ?? "").trim();
        if (!clientName) return { ok: false, message: "Which client is this invoice for?" };
        const dollars = Number(args.amount);
        if (!Number.isFinite(dollars) || dollars <= 0) {
          return { ok: false, message: "What dollar amount should the invoice be for?" };
        }
        const inv = await createInvoice(user.id, {
          clientName,
          clientEmail: args.clientEmail ? String(args.clientEmail).trim() : undefined,
          amountCents: Math.round(dollars * 100),
          dueDate: args.dueDate ? String(args.dueDate).trim() : undefined,
          invoiceNumber: args.invoiceNumber ? String(args.invoiceNumber).trim() : undefined,
        });
        await recordActivity({
          userId: user.id,
          kind: "invoice_created",
          title: `Invoice ${inv.invoiceNumber} added for ${inv.clientName}`,
          detail: `$${(inv.amountCents / 100).toLocaleString("en-US")} · due ${inv.dueDate}`,
          entityType: "invoice",
          entityId: inv.id,
          status: "done",
        });
        return {
          ok: true,
          message: `Added invoice ${inv.invoiceNumber} for ${inv.clientName} — $${(inv.amountCents / 100).toLocaleString("en-US")} due ${inv.dueDate}.`,
        };
      }
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
      case "gather_tax_docs": {
        const targetName = String(args.contractorName ?? "").trim().toLowerCase();
        const contractors = await listContractors(user.id);
        const candidates = targetName
          ? contractors.filter((c) => c.name.toLowerCase().includes(targetName) && c.email)
          : contractors.filter((c) => needsW9(c) && c.email);
        if (candidates.length === 0) {
          return {
            ok: false,
            message: targetName
              ? `No contractor named "${args.contractorName}" with an email needs a W-9 right now.`
              : "No contractors over the reporting threshold currently need a W-9.",
          };
        }
        let sent = 0;
        for (const c of candidates) {
          try {
            await sendW9Request(user, c.id);
            sent++;
          } catch {
            /* skip one failure, keep going */
          }
        }
        return { ok: true, message: `Requested W-9 tax docs from ${sent} contractor${sent === 1 ? "" : "s"}.` };
      }
      case "prepare_meeting_packet": {
        const clientName = String(args.clientName ?? "").trim();
        if (!clientName) return { ok: false, message: "Which client should I prepare a packet for?" };
        const packet = await prepareMeetingPacket(user, clientName);
        return { ok: true, message: `Meeting packet for ${packet.clientName} emailed to ${packet.emailedTo}.` };
      }
      case "send_client_update": {
        const clientName = String(args.clientName ?? "").trim();
        if (!clientName) return { ok: false, message: "Which client should I email?" };
        const sent = await sendClientCommunication(user, clientName, args.topic ? String(args.topic) : undefined);
        return { ok: true, message: `Sent "${sent.subject}" to ${sent.recipients.join(", ")}.` };
      }
      case "resolve_compliance": {
        const res = await resolveCompliance(user.id, {
          clientRef: args.clientName ? String(args.clientName) : undefined,
          type: args.type ? (String(args.type) as ComplianceType) : undefined,
        });
        if (res.resolved === 0) return { ok: false, message: "No matching open compliance actions to resolve." };
        return { ok: true, message: `Marked ${res.resolved} compliance action(s) done: ${res.titles.join(", ")}.` };
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
