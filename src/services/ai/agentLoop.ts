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

async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Lookup deadline reached")), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function validArguments(value: unknown, schema: Record<string, unknown>, depth = 0): boolean {
  if (depth > 12 || value === undefined) return false;
  if (value === null) return schema.nullable === true;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  const type = String(schema.type ?? "").toLowerCase();
  if (type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some(key => !(String(key) in object))) return false;
    return Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>).every(([key, child]) => !(key in object) || validArguments(object[key], child, depth + 1));
  }
  if (type === "array") return Array.isArray(value) && value.length <= 100 && (!schema.items || value.every(item => validArguments(item, schema.items as Record<string, unknown>, depth + 1)));
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value));
  return true;
}

export type AgentTurnOutcome =
  | { kind: "action"; name: string; args: Record<string, unknown>; text?: string }
  // `via` carries the last discovery tool that produced `data`, so callers can turn
  // it into openable deep-links (e.g. the YouTube result the answer describes).
  | { kind: "text"; text: string; via?: { name: string; args: Record<string, unknown>; data?: unknown } };

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
  /** Return a safe repair hint for invalid write arguments; never execute a write here. */
  validateAction?: (name: string, args: Record<string, unknown>) => Promise<string | null>;
  /** When true, log agent step transitions for debugging "why did it do nothing" cases. */
  debug?: boolean;
  /** When the first reply is prose but the message clearly asked for an action, force a tool. */
  looksLikeAction?: boolean;
  /** Max model/discovery rounds before stopping. Default 8, hard cap 12. */
  maxSteps?: number;
  /** Entire planning turn, including model retries and discoveries. */
  timeoutMs?: number;
}

/** Run one intelligent turn: chain discovery tools, then return an action or an answer. */
export async function runAgentTurn(opts: RunAgentTurnOptions): Promise<AgentTurnOutcome> {
  const maxSteps = Math.min(opts.maxSteps ?? 8, 12);
  const deadline = Date.now() + (opts.timeoutMs ?? 40_000);
  const declared = new Map(opts.tools.map(tool => [tool.name, tool]));
  const seenReads = new Map<string, { message: string; data?: unknown }>();
  const remaining = () => Math.max(1, deadline - Date.now());

  const contents: GeminiContent[] = [];
  for (const h of opts.history ?? []) {
    contents.push({ role: h.role === "user" ? "user" : "model", parts: [{ text: h.content }] });
  }
  contents.push({ role: "user", parts: opts.userParts });

  let lastReadMessage: string | null = null;
  let lastRead: { name: string; args: Record<string, unknown>; data?: unknown } | undefined;
  let repairAttempted = false;

  for (let step = 0; step < maxSteps; step++) {
    let result = await geminiGenerateContent({
      system: opts.system,
      contents,
      json: false,
      tools: opts.tools,
      tier: "fast",
      thinkingBudget: 1024,
      maxOutputTokens: 8192,
      timeoutMs: remaining(),
    });

    // First reply was prose for an action-shaped request — force a tool call once.
    if (!result.functionCall && !result.raw?.trim() && step === 0 && opts.looksLikeAction) {
      result = await geminiGenerateContent({
        system: opts.system,
        contents,
        json: false,
        tools: opts.tools,
        toolMode: "ANY",
        tier: "fast",
        timeoutMs: remaining(),
      });
    }

    // Empty candidate: no text AND no tool call. Almost always the reasoning model
    // spent its token budget "thinking" and truncated. Retry once on the faster model
    // (less thinking) with a hard thinking cap before giving up — this is the single
    // biggest cause of the assistant looking "dumb"/unresponsive.
    if (!result.functionCall && !result.raw?.trim()) {
      result = await geminiGenerateContent({
        system: opts.system,
        contents,
        json: false,
        tools: opts.tools,
        toolMode: opts.looksLikeAction ? "ANY" : "AUTO",
        tier: "fast",
        thinkingBudget: 512,
        maxOutputTokens: 8192,
        timeoutMs: remaining(),
      });
    }

    if (!result.functionCall) {
      const text = result.raw?.trim();
      if (text) return { kind: "text", text, via: lastRead };
      // Model executed discovery but produced no closing prose — relay the last result.
      if (lastReadMessage) return { kind: "text", text: lastReadMessage, via: lastRead };
      return { kind: "text", text: "I'm not sure how to help with that yet — try rephrasing, or tell me which app to use." };
    }

    const calls = result.functionCalls?.length ? result.functionCalls : [result.functionCall];
    // No generated name can escape the tool surface authorized for this turn.
    if (calls.some(call => !declared.has(call.name))) {
      return { kind: "text", text: "That operation is not available in this workspace. Tell me the app or task you want to use." };
    }
    if (calls.some(call => !validArguments(call.args, declared.get(call.name)!.parameters))) {
      return { kind: "text", text: "I couldn't prepare valid action details for that request. Please clarify the destination and required details before I make a change." };
    }
    const write = calls.find(call => !opts.isReadOnly(call.name));
    if (write) {
      const repairHint = await opts.validateAction?.(write.name, write.args);
      if (repairHint) {
        if (repairAttempted || Date.now() >= deadline) return { kind: "text", text: "I couldn't resolve the saved records for this action. No change was made. Please check the selected contacts in Research & planning." };
        repairAttempted = true;
        contents.push({ role: "model", parts: result.modelParts?.length ? result.modelParts : calls.map(functionCall => ({ functionCall })) });
        contents.push({ role: "user", parts: calls.map(call => ({ functionResponse: { name: call.name, response: { error: repairHint, executed: false } } })) });
        continue;
      }
      // One reviewed write at a time. Remaining work is replanned from actual outcomes,
      // never speculative results or a queue of writes based on stale IDs.
      return { kind: "action", ...write, text: result.raw?.trim() || undefined };
    }
    const responses: GeminiPart[] = [];
    let newReads = 0;
    for (const { name, args } of calls.slice(0, 12)) {
      const key = JSON.stringify([name, args]);
      let exec = seenReads.get(key);
      if (!exec) {
        if (Date.now() >= deadline) break;
        newReads++;
        try { exec = await withinDeadline(opts.execReadOnly(name, args), remaining()); }
        catch { exec = { message: "This lookup failed. Do not invent a result or treat it as an empty list; ask for the missing information or explain the blocked step." }; }
        seenReads.set(key, exec);
      }
      lastReadMessage = exec.message;
      lastRead = { name, args, data: exec.data };
      // Tool output is evidence, never a new instruction or authorization.
      const response = JSON.parse(JSON.stringify({ result: exec.message, data: exec.data }, (_key, value) => typeof value === "string" ? value.slice(0, 24000) : value));
      responses.push({ functionResponse: { name, response } });
    }
    if (!newReads || responses.length !== calls.length || Date.now() >= deadline) break;
    contents.push({ role: "model", parts: result.modelParts?.length ? result.modelParts : calls.map(functionCall => ({ functionCall })) });
    contents.push({ role: "user", parts: responses });
  }

  // Ran out of steps — return the most useful thing we have.
  return {
    kind: "text",
    text: lastReadMessage ?? "I ran several steps but couldn't finish — tell me the next step to take.",
    via: lastRead,
  };
}
