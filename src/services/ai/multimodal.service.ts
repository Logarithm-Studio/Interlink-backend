/**
 * Multimodal + agentic AI service (Professional Mode, iter3).
 *
 * - `extractReceipt`  — Gemini vision: receipt image → structured expense fields.
 * - `transcribeAudio` — Gemini audio: voice clip → text (for the command bar).
 * - `planAgentActions` — Gemini function-calling: a command → answer or a proposed action.
 *
 * All gate on `isGeminiLive()` with deterministic fallbacks for the offline/demo case.
 */

import { geminiGenerateContent, isGeminiLive } from "./geminiClient";
import { AGENT_SYSTEM, AGENT_TOOLS } from "./prompts/agentTools";
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

export async function planAgentActions(params: {
  message: string;
  snapshot: string;
}): Promise<AgentPlan> {
  if (!isGeminiLive()) {
    return {
      answer:
        "The AI service is offline right now. You can still send reminders and run audits from the dashboard.",
      isLive: false,
    };
  }
  try {
    const result = await geminiGenerateContent({
      system: AGENT_SYSTEM,
      parts: [
        { text: `DATA SNAPSHOT:\n${params.snapshot}` },
        { text: `USER: ${params.message}` },
      ],
      tools: AGENT_TOOLS,
      maxOutputTokens: 1024,
    });
    if (result.functionCall) {
      return {
        action: { name: result.functionCall.name, args: result.functionCall.args },
        isLive: true,
      };
    }
    return { answer: result.raw.trim() || "Done.", isLive: true };
  } catch (err) {
    console.error("[multimodal] agent planning failed:", err);
    return { answer: "Sorry, I couldn't process that just now.", isLive: true };
  }
}
