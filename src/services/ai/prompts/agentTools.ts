/**
 * Agent persona + function-calling tool declarations for the AI command center (iter3).
 *
 * Only ACTION tools are declared to Gemini. Read/info questions are answered from
 * the DATA SNAPSHOT passed in the prompt (single-turn — no tool round-trips). The
 * model either answers in text or calls exactly one action function, which the
 * backend turns into a `pendingAction` requiring user confirmation.
 */

import type { GeminiToolFunction } from "../geminiClient";

export const AGENT_SYSTEM = [
  "You are the user's AI accountant agent inside the Interlink app.",
  "You can (a) ANSWER questions about their accounts-receivable and expenses using ONLY the DATA SNAPSHOT,",
  "and (b) PERFORM an action by calling a function when the user clearly asks you to do something.",
  "Your capabilities:",
  "- Dunning: send_reminder (one client) / remind_all_overdue (every overdue client), with an escalation tone.",
  "- Expense auditing: run_expense_audit flags anomalous expenses.",
  "- Flash reporting: email_flash_report sends the AR + expense + cash-runway summary.",
  "- Tax gathering: gather_tax_docs requests W-9/1099 forms from contractors over the reporting threshold.",
  "- Automation control: pause_client, set_automation (off/suggest/auto).",
  "RULES:",
  "- Reason step by step: infer the goal (use conversation history to resolve references), pick the right tool, resolve a client to its invoiceId from the snapshot when you can (otherwise pass clientName), then act.",
  "- Never invent numbers, clients, dates, or links. If the snapshot lacks the answer, say so.",
  "- Call a function ONLY for a clear action request. Otherwise answer in text.",
  "- You never actually send anything yourself — the app asks the user to confirm before executing.",
  "- Tone: precise, professional, and human — never robotic or childish. Prefer doing over explaining.",
].join("\n");

const noParams = { type: "object", properties: {} } as const;

export const AGENT_TOOLS: GeminiToolFunction[] = [
  {
    name: "send_reminder",
    description: "Draft and send a payment reminder for one overdue invoice / client.",
    parameters: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "Invoice id from the snapshot, if known." },
        clientName: { type: "string", description: "Client name, if invoiceId is unknown." },
        tone: { type: "string", enum: ["friendly", "firm", "final"], description: "Escalation tone." },
      },
    },
  },
  {
    name: "remind_all_overdue",
    description: "Send tailored reminders to every overdue client.",
    parameters: noParams,
  },
  {
    name: "run_expense_audit",
    description: "Run an AI audit over expenses to flag anomalies.",
    parameters: noParams,
  },
  {
    name: "email_flash_report",
    description: "Email the flash financial report to the user.",
    parameters: noParams,
  },
  {
    name: "pause_client",
    description: "Pause automated dunning reminders for a specific client.",
    parameters: {
      type: "object",
      properties: { clientName: { type: "string", description: "Client to pause." } },
      required: ["clientName"],
    },
  },
  {
    name: "gather_tax_docs",
    description:
      "Request W-9/1099 tax forms from contractors paid over the reporting threshold who still need one. Optionally target a single contractor by name; otherwise requests from all who qualify.",
    parameters: {
      type: "object",
      properties: {
        contractorName: { type: "string", description: "Optional: a single contractor to request from." },
      },
    },
  },
  {
    name: "set_automation",
    description: "Set an automation's autonomy level (off/suggest/auto).",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["dunning_sequence", "expense_audit", "flash_report", "tax_docs"],
        },
        autonomy: { type: "string", enum: ["off", "suggest", "auto"] },
      },
      required: ["type", "autonomy"],
    },
  },
];

export type AgentActionName =
  | "send_reminder"
  | "remind_all_overdue"
  | "run_expense_audit"
  | "email_flash_report"
  | "gather_tax_docs"
  | "pause_client"
  | "set_automation";

/** Human-readable summary of a proposed action (for the confirm card). */
export function summarizeAction(
  name: string,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case "send_reminder":
      return `Send a${args.tone ? ` ${args.tone}` : ""} payment reminder to ${args.clientName ?? "the selected client"}.`;
    case "remind_all_overdue":
      return "Send tailored reminders to all overdue clients.";
    case "run_expense_audit":
      return "Run an AI audit over your expenses.";
    case "email_flash_report":
      return "Email you the flash financial report.";
    case "gather_tax_docs":
      return `Request W-9 tax docs from ${args.contractorName ?? "all contractors over the threshold"}.`;
    case "pause_client":
      return `Pause automated reminders for ${args.clientName ?? "this client"}.`;
    case "set_automation":
      return `Set ${args.type} automation to ${args.autonomy}.`;
    default:
      return `Run ${name}.`;
  }
}

/** Whether an action mutates money/state and therefore needs confirmation. */
export function isMoneyAdjacent(name: string): boolean {
  return name === "send_reminder" || name === "remind_all_overdue";
}
