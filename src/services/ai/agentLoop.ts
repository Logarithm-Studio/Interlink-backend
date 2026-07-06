/**
 * Shared multi-step agent loop (Personal + Professional command centers).
 *
 * The old flow was single-shot: one Gemini call → one function call → stop. That
 * dead-ends multi-app workflows ("post the standup to Slack" could only *list*
 * channels, then the user had to re-prompt). This loop lets the model chain:
 * it runs read-only/discovery tools server-side, feeds their results back as
 * functionResponse turns, and continues — until it either returns a WRITE action
 * (which the caller confirms before executing) or a final prose answer.
 *
 * Writes never auto-execute here: the first non-read-only function call is returned
 * for the human-in-the-loop confirmation the app already implements.
 */

import {
  geminiGenerateContent,
  type GeminiContent,
  type GeminiPart,
  type GeminiToolFunction,
} from "./geminiClient";

export type AgentTurnOutcome =
  | { kind: "action"; name: string; args: Record<string, unknown> }
  | { kind: "text"; text: string };

export interface RunAgentTurnOptions {
  system: string;
  tools: GeminiToolFunction[];
  /** The current user turn's parts (e.g. connected-apps summary, message text, an image). */
  userParts: GeminiPart[];
  /** Prior conversation turns, oldest-first, for memory/pronoun resolution. */
  history?: { role: "user" | "assistant"; content: string }[];
  /** True for tools that read/discover and may be executed automatically to chain. */
  isReadOnly: (name: string) => boolean;
  /** Executes a read-only tool and returns a concise result to feed back to the model. */
  execReadOnly: (name: string, args: Record<string, unknown>) => Promise<{ message: string; data?: unknown }>;
  /** When the first reply is prose but the message clearly asked for an action, force a tool. */
  looksLikeAction?: boolean;
  /** Max chained steps (read-only tool calls) before we stop. Default 4. */
  maxSteps?: number;
}

/** Run one intelligent turn: chain discovery tools, then return an action or an answer. */
export async function runAgentTurn(opts: RunAgentTurnOptions): Promise<AgentTurnOutcome> {
  const maxSteps = opts.maxSteps ?? 4;

  const contents: GeminiContent[] = [];
  for (const h of opts.history ?? []) {
    contents.push({ role: h.role === "user" ? "user" : "model", parts: [{ text: h.content }] });
  }
  contents.push({ role: "user", parts: opts.userParts });

  let lastReadMessage: string | null = null;

  for (let step = 0; step < maxSteps; step++) {
    let result = await geminiGenerateContent({
      system: opts.system,
      contents,
      json: false,
      tools: opts.tools,
      tier: "reasoning",
    });

    // First reply was prose for an action-shaped request — force a tool call once.
    if (!result.functionCall && step === 0 && opts.looksLikeAction) {
      result = await geminiGenerateContent({
        system: opts.system,
        contents,
        json: false,
        tools: opts.tools,
        toolMode: "ANY",
        tier: "reasoning",
      });
    }

    if (!result.functionCall) {
      const text = result.raw?.trim();
      if (text) return { kind: "text", text };
      // Model executed discovery but produced no closing prose — relay the last result.
      if (lastReadMessage) return { kind: "text", text: lastReadMessage };
      return { kind: "text", text: "I'm not sure how to help with that." };
    }

    const { name, args } = result.functionCall;

    // A write action: hand it back for confirmation (args now resolved from any
    // discovery steps we already ran, e.g. the Slack channel id or Trello board id).
    if (!opts.isReadOnly(name)) {
      return { kind: "action", name, args };
    }

    // A read/discovery step: execute it and feed the result back so the model can chain.
    const exec = await opts.execReadOnly(name, args);
    lastReadMessage = exec.message;
    contents.push({ role: "model", parts: [{ functionCall: { name, args } }] });
    contents.push({
      role: "user",
      parts: [{ functionResponse: { name, response: { result: exec.message } } }],
    });
  }

  // Ran out of steps — return the most useful thing we have.
  return {
    kind: "text",
    text: lastReadMessage ?? "I ran several steps but couldn't finish — tell me the next step to take.",
  };
}
