/**
 * Multimodal + agentic AI service (Professional Mode, iter3).
 *
 * - `extractReceipt`  — Gemini vision: receipt image → structured expense fields.
 * - `transcribeAudio` — Gemini audio: voice clip → text (for the command bar).
 * - `planAgentActions` — Gemini function-calling: a command → answer or a proposed action.
 *
 * All gate on `isGeminiLive()` with deterministic fallbacks for the offline/demo case.
 */

import { geminiGenerateContent, isGeminiLive, type GeminiPart, type GeminiToolFunction } from "./geminiClient";
import { runAgentTurn } from "./agentLoop";
import { AGENT_SYSTEM, AGENT_TOOLS } from "./prompts/agentTools";
import { tryParseSpreadsheetAttachment, spreadsheetContextText, DRIVE_SHEET_TOOL_NAMES, ATTACHMENT_DIRECTIVE } from "../professional/spreadsheet.service";
import {
  buildFallbackReceiptExtract,
  RECEIPT_EXTRACT_SYSTEM,
  ReceiptExtract,
  ReceiptExtractSchema,
} from "./prompts/receiptExtract";

// ─── Receipt vision extraction ────────────────────────────────────────────────

export interface ExtractReceiptResult {
  receipt: ReceiptExtract;
  isFallback: boolean;
}

export async function extractReceipt(
  imageBase64: string,
  mimeType = "image/jpeg",
): Promise<ExtractReceiptResult> {
  if (!isGeminiLive()) {
    return { receipt: buildFallbackReceiptExtract(), isFallback: true };
  }
  try {
    const result = await geminiGenerateContent({
      system: RECEIPT_EXTRACT_SYSTEM,
      parts: [
        { inlineData: { mimeType, data: imageBase64 } },
        { text: "Extract this receipt." },
      ],
      json: true,
      maxOutputTokens: 1024,
    });
    const parsed = ReceiptExtractSchema.safeParse(JSON.parse(result.raw));
    if (!parsed.success) throw new Error(parsed.error.message);
    return { receipt: parsed.data, isFallback: false };
  } catch (err) {
    console.error("[multimodal] receipt extract failed — fallback:", err);
    return { receipt: buildFallbackReceiptExtract(), isFallback: true };
  }
}

// ─── Audio transcription ──────────────────────────────────────────────────────

export interface TranscribeResult {
  text: string;
  isLive: boolean;
}

export async function transcribeAudio(
  audioBase64: string,
  mimeType = "audio/m4a",
): Promise<TranscribeResult> {
  if (!isGeminiLive()) return { text: "", isLive: false };
  try {
    const result = await geminiGenerateContent({
      system:
        'Transcribe the attached audio to text verbatim. Return ONLY JSON: {"text": string}.',
      parts: [
        { inlineData: { mimeType, data: audioBase64 } },
        { text: "Transcribe." },
      ],
      json: true,
      maxOutputTokens: 512,
    });
    const obj = JSON.parse(result.raw) as { text?: unknown };
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    return { text, isLive: true };
  } catch (err) {
    console.error("[multimodal] transcription failed:", err);
    return { text: "", isLive: true };
  }
}

// ─── Agentic planning (function-calling) ──────────────────────────────────────

export interface AgentPlan {
  /** A direct text answer (when no action was requested). */
  answer?: string;
  /** A proposed action the user must confirm before execution. */
  action?: { name: string; args: Record<string, unknown> };
  /** The last discovery tool that produced data, so callers can derive openable deep-links. */
  via?: { name: string; args: Record<string, unknown>; data?: unknown };
  isLive: boolean;
}

/**
 * Persona-general assistant reply (non-finance professional roles).
 *
 * Finance has bespoke tools + a live data snapshot; the other roles don't have
 * data integrations wired yet, so the agent answers as a domain expert for that
 * role (HR, sales, legal, …) and is honest that live records aren't connected,
 * instead of refusing with the accountant script.
 */
export async function planPersonaReply(params: {
  personaLabel: string;
  message: string;
  history?: { role: "user" | "assistant"; content: string }[];
}): Promise<{ answer: string; isLive: boolean }> {
  if (!isGeminiLive()) {
    return {
      answer:
        "The AI service is offline right now. Add a GEMINI_API_KEY to enable live answers.",
      isLive: false,
    };
  }
  const system = [
    `You are the user's AI ${params.personaLabel} assistant inside the Interlink app.`,
    `Help with ${params.personaLabel} work: answering questions, drafting messages/emails,`,
    "planning, summarizing, and giving practical step-by-step guidance.",
    "Be concise and useful. Use short markdown bullet lists when enumerating.",
    "Live data integrations (CRM, ATS, GitHub, calendars, etc.) are not connected yet.",
    "When asked for specific live records you don't have, say so briefly and offer a useful",
    "template, checklist, or next step instead of inventing data.",
  ].join("\n");

  const historyText = (params.history ?? [])
    .slice(-6)
    .map((t) => `${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.content}`)
    .join("\n");

  try {
    const result = await geminiGenerateContent({
      system,
      parts: [
        ...(historyText ? [{ text: `CONVERSATION SO FAR:\n${historyText}` }] : []),
        { text: `USER: ${params.message}` },
      ],
      json: false,
      maxOutputTokens: 1024,
    });
    return { answer: result.raw.trim() || "Done.", isLive: true };
  } catch (err) {
    console.error("[multimodal] persona reply failed:", err);
    return { answer: "Sorry, I couldn't process that just now.", isLive: true };
  }
}

// Verbs/nouns that signal an actionable command across the professional verticals
// (finance, sales, PM, HR, support, real-estate) + the shared personal tools.
const AGENT_ACTION_INTENT =
  /\b(create|add|make|new|send|draft|write|generate|update|assign|move|close|remind|schedule|log|post|file|enrich|route|clean|sync|release|record|mark|pay|invoice|refund)\b|\b(ticket|issue|invoice|reminder|deal|contact|lead|contract|report|expense|receipt|task|card|pr|pull request|release notes|sprint|campaign|note|page|channel|meeting)\b/i;

function looksLikeAgentActionRequest(message: string): boolean {
  return AGENT_ACTION_INTENT.test(message);
}

export async function planAgentActions(params: {
  message: string;
  snapshot: string;
  /** Persona-specific tool declarations (defaults to the finance/accountant set). */
  tools?: GeminiToolFunction[];
  /** Persona-specific system prompt (defaults to the finance/accountant agent). */
  system?: string;
  /** Optional attached file (image/PDF/spreadsheet/…) the user sent with the message. */
  attachment?: { data: string; mimeType: string; name?: string };
  /** Prior conversation turns (oldest-first) so the agent has memory. */
  history?: { role: "user" | "assistant"; content: string }[];
  /**
   * When provided together, the planner CHAINS: read-only tools are executed
   * server-side and their results fed back so the model can take the next step
   * (discover → act) in one turn. Without them it stays single-shot (any function
   * call is returned for confirmation).
   */
  isReadOnly?: (name: string) => boolean;
  execReadOnly?: (name: string, args: Record<string, unknown>) => Promise<{ message: string; data?: unknown }>;
}): Promise<AgentPlan> {
  if (!isGeminiLive()) {
    return {
      answer:
        "The AI service is offline right now. You can still take actions from the dashboard.",
      isLive: false,
    };
  }

  // A spreadsheet attachment (.xlsx/.xls/.csv) can't be read by the model as inlineData — parse it
  // to a text table so the agent can analyze the rows and act on them (enlist, email each row,
  // summarize). Detection does NOT trust the mime/name (Android sends octet-stream), it tries to
  // parse the bytes. When it IS a sheet, we also strip the Google-Drive sheet tools for this turn
  // so the agent can't fall back to "find a Google Sheet named …". Images/PDFs stay inline.
  let toolsForTurn = params.tools ?? AGENT_TOOLS;
  const attachmentParts: GeminiPart[] = [];
  if (params.attachment) {
    // Any attachment: make it the subject of the turn (the model must not ignore it).
    attachmentParts.push({ text: ATTACHMENT_DIRECTIVE });
    const sheet = tryParseSpreadsheetAttachment(params.attachment.data, params.attachment.mimeType, params.attachment.name);
    if (sheet) {
      attachmentParts.push({ text: spreadsheetContextText(sheet, params.attachment.name) });
      toolsForTurn = toolsForTurn.filter((t) => !DRIVE_SHEET_TOOL_NAMES.includes(t.name));
    } else {
      attachmentParts.push({ inlineData: { mimeType: params.attachment.mimeType, data: params.attachment.data } });
    }
  }

  const userParts: GeminiPart[] = [
    {
      text:
        `CONTEXT — the current date and time is ${new Date().toISOString()} (UTC). ` +
        `Resolve relative dates against this and never schedule or create anything in the past. ` +
        `When scheduling, emit the user's intended time as a plain local wall-clock datetime WITHOUT a "Z" or UTC offset ` +
        `(e.g. 2026-07-11T15:00:00) — the calendar applies the user's own timezone. Do not convert to UTC yourself.`,
    },
    { text: `DATA SNAPSHOT:\n${params.snapshot}` },
    ...attachmentParts,
    { text: `USER: ${params.message}` },
  ];

  try {
    const outcome = await runAgentTurn({
      system: params.system ?? AGENT_SYSTEM,
      tools: toolsForTurn,
      userParts,
      history: params.history,
      isReadOnly: params.isReadOnly ?? (() => false),
      execReadOnly: params.execReadOnly ?? (async () => ({ message: "" })),
      looksLikeAction: looksLikeAgentActionRequest(params.message),
    });
    return outcome.kind === "action"
      ? { action: { name: outcome.name, args: outcome.args }, isLive: true }
      : { answer: outcome.text || "Done.", isLive: true, via: outcome.via };
  } catch (err) {
    console.error("[multimodal] agent planning failed:", err);
    return { answer: "Sorry, I couldn't process that just now.", isLive: true };
  }
}
