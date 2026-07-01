/**
 * Shared Gemini email/text drafting for professional verticals. JSON-only with a
 * deterministic fallback so callers work offline/demo too.
 */

import { geminiGenerateContent, isGeminiLive } from "../ai/geminiClient";

export async function draftEmail(params: {
  /** The writer's role, e.g. "sales representative". */
  role: string;
  /** What to write, e.g. "a friendly follow-up to a prospect". */
  purpose: string;
  /** Grounding facts (names, deal, ticket text, …). */
  context: string;
}): Promise<{ subject: string; body: string; isFallback: boolean }> {
  const fallback = {
    subject: "Following up",
    body: "Hi,\n\nJust following up on this — let me know if I can help.\n\nBest regards",
    isFallback: true,
  };
  if (!isGeminiLive()) return fallback;
  try {
    const result = await geminiGenerateContent({
      system:
        `You are a ${params.role}. Write ${params.purpose}. ` +
        `Return ONLY JSON: {"subject": string, "body": string}. ` +
        `Keep it concise, warm, and ready to send. Never invent facts not in the context.`,
      parts: [{ text: params.context }],
      json: true,
      maxOutputTokens: 800,
    });
    const obj = JSON.parse(result.raw) as { subject?: unknown; body?: unknown };
    const subject = typeof obj.subject === "string" && obj.subject.trim() ? obj.subject.trim() : fallback.subject;
    const body = typeof obj.body === "string" && obj.body.trim() ? obj.body.trim() : "";
    return body ? { subject, body, isFallback: false } : fallback;
  } catch {
    return fallback;
  }
}
