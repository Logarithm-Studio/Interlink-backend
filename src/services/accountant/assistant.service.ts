/**
 * "Ask your AI accountant" assistant service (Professional Mode).
 *
 * Builds a compact snapshot of the user's AR + expenses (tool-less RAG), asks
 * Gemini to answer grounded in it, and persists the conversation for memory.
 */

import { createHash } from "crypto";
import { query } from "../../config/db";
import { generateAssistantReply } from "../ai/ai.service";
import type { AssistantReply, AssistantChatTurn } from "../ai/prompts/assistant";
import { listInvoices } from "./invoices.service";
import { listExpenses } from "./expenses.service";

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
