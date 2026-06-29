/**
 * Prompt + schema for the "Ask your AI accountant" assistant.
 *
 * Gemini answers questions grounded ONLY in the user's own AR/expense context
 * passed in-prompt (a tool-less RAG). It never invents figures or links, and it
 * proposes (but never performs) follow-up actions.
 */

import { z } from "zod";

export const AssistantReplySchema = z.object({
  answer: z.string().min(1),
  suggestedActions: z
    .array(
      z.object({
        label: z.string().min(1),
        kind: z.enum([
          "view_invoices",
          "remind_overdue",
          "run_audit",
          "view_report",
          "none",
        ]),
      }),
    )
    .default([]),
});

export type AssistantReply = z.infer<typeof AssistantReplySchema>;

export interface AssistantChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantContext {
  /** Compact, pre-formatted snapshot of the user's AR + expenses. */
  dataSnapshot: string;
  history: AssistantChatTurn[];
  message: string;
}

export function buildAssistantPrompt(ctx: AssistantContext): {
  system: string;
  user: string;
} {
  const system = [
    "You are the user's AI accountant assistant inside the Interlink app.",
    "Answer questions about THEIR accounts-receivable and expenses using ONLY the DATA SNAPSHOT provided.",
    "RULES:",
    "- Never invent numbers, clients, dates, or links. If the snapshot doesn't contain the answer, say so.",
    "- Be concise and practical (a few sentences). Use figures from the snapshot.",
    "- You may suggest follow-up actions via `suggestedActions` (the app performs them, not you).",
    "- You never send emails or move money yourself.",
    'Return ONLY JSON: {"answer":string,"suggestedActions":[{"label":string,"kind":"view_invoices|remind_overdue|run_audit|view_report|none"}]}.',
  ].join("\n");

  const historyText = ctx.history
    .slice(-6)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");

  const user = [
    "DATA SNAPSHOT:",
    ctx.dataSnapshot,
    "",
    historyText ? `CONVERSATION SO FAR:\n${historyText}\n` : "",
    `USER QUESTION: ${ctx.message}`,
  ].join("\n");

  return { system, user };
}

export function buildFallbackAssistantReply(): AssistantReply {
  return {
    answer:
      "I couldn't reach the AI service just now. You can review your overdue invoices and send reminders from the dashboard in the meantime.",
    suggestedActions: [{ label: "View overdue invoices", kind: "view_invoices" }],
  };
}
