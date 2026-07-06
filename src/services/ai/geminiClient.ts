/**
 * Standalone Gemini multimodal + function-calling client (Professional Mode, iter3).
 *
 * The per-mode `provider.ts` stays the JSON-text abstraction; this module adds the
 * Gemini-specific capabilities (image/audio `inline_data`, `functionDeclarations`)
 * via the same REST endpoint + global `fetch` (no SDK). Reads the same env as the
 * Gemini provider: `GEMINI_API_KEY` / `GEMINI_MODEL` / `PROFESSIONAL_AI_PROVIDER`.
 *
 * Callers gate on `isGeminiLive()` and provide deterministic fallbacks for the
 * offline/demo case (no live key) — same philosophy as the JSON generators.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  // Prior model tool call / our tool result — used to drive multi-step agent loops.
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

/** One conversation turn. `model` turns carry the assistant's text/functionCall;
 *  `user` turns carry the user's message or a functionResponse from a tool we ran. */
export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiToolFunction {
  name: string;
  description: string;
  /** JSON-Schema object describing the function's parameters. */
  parameters: Record<string, unknown>;
}

export interface GeminiResult {
  /** Concatenated text parts (JSON string when `json` was requested). */
  raw: string;
  /** Present when the model chose to call a declared function. */
  functionCall?: { name: string; args: Record<string, unknown> };
  model: string;
  latencyMs: number;
}

// ─── Config ─────────────────────────────────────────────────────────────────

/**
 * Two-tier model selection. Multi-step/agentic turns use the stronger REASONING
 * model (the "brain"); trivial single reads use the cheaper/faster FAST model.
 * Both are env-overridable.
 */
function geminiConfig(tier: "reasoning" | "fast" = "fast"): { apiKey?: string; model: string; demo: boolean } {
  const providerName = (process.env.PROFESSIONAL_AI_PROVIDER ?? "gemini")
    .toLowerCase()
    .trim();
  const apiKey = process.env.GEMINI_API_KEY;
  const model =
    tier === "reasoning"
      ? process.env.GEMINI_REASONING_MODEL ?? "gemini-2.5-pro"
      : process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  return { apiKey, model, demo: providerName === "demo" || !apiKey };
}

/** True when a live Gemini call is possible (not demo, key present). */
export function isGeminiLive(): boolean {
  return !geminiConfig().demo;
}

// ─── REST call ────────────────────────────────────────────────────────────────

function toApiPart(p: GeminiPart): Record<string, unknown> {
  if ("text" in p) return { text: p.text };
  if ("inlineData" in p) return { inline_data: { mime_type: p.inlineData.mimeType, data: p.inlineData.data } };
  if ("functionCall" in p) return { functionCall: { name: p.functionCall.name, args: p.functionCall.args } };
  return { functionResponse: { name: p.functionResponse.name, response: p.functionResponse.response } };
}

export async function geminiGenerateContent(args: {
  system: string;
  /** Single user turn. Ignored when `contents` is provided. */
  parts?: GeminiPart[];
  /**
   * Full multi-turn conversation (user/model turns incl. functionCall/functionResponse).
   * When present it replaces `parts` — this is how the agent loop feeds tool results back.
   */
  contents?: GeminiContent[];
  /** Force JSON output (default true). Ignored when `tools` are present. */
  json?: boolean;
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  /** Sampling temperature. Ignored for JSON output (always 0). Defaults to 0.4. */
  temperature?: number;
  /** "reasoning" → the stronger brain model (agentic/multi-step); "fast" → cheap reads. */
  tier?: "reasoning" | "fast";
  tools?: GeminiToolFunction[];
  /**
   * Function-calling mode when `tools` are present. "AUTO" (default) lets the model
   * choose between prose and a tool; "ANY" forces it to return a function call —
   * used as a second-pass retry when an obvious action produced prose the first time.
   */
  toolMode?: "AUTO" | "ANY";
  timeoutMs?: number;
}): Promise<GeminiResult> {
  const { apiKey, model, demo } = geminiConfig(args.tier);
  if (demo || !apiKey) {
    throw new Error("Gemini is not configured (PROFESSIONAL_AI_PROVIDER=demo or no GEMINI_API_KEY)");
  }

  const start = Date.now();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const useJson = (args.json ?? true) && !args.tools;
  const generationConfig: Record<string, unknown> = {
    // JSON generators stay deterministic; conversational/agentic turns get a little
    // warmth so responses don't read robotic/childish.
    temperature: useJson ? 0 : args.temperature ?? 0.4,
    // Agentic (tool) turns get more room to reason without truncation.
    maxOutputTokens: args.maxOutputTokens ?? (args.tools ? 4096 : 2048),
  };
  if (useJson) {
    generationConfig.responseMimeType = "application/json";
    if (args.responseSchema) generationConfig.responseSchema = args.responseSchema;
  }

  const contents = args.contents
    ? args.contents.map((c) => ({ role: c.role, parts: c.parts.map(toApiPart) }))
    : [{ role: "user", parts: (args.parts ?? []).map(toApiPart) }];

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: args.system }] },
    contents,
    generationConfig,
  };
  if (args.tools && args.tools.length > 0) {
    body.tools = [
      {
        function_declarations: args.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
    body.tool_config = {
      function_calling_config: { mode: args.toolMode ?? "AUTO" },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 30_000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    candidates?: {
      content?: {
        parts?: {
          text?: string;
          functionCall?: { name?: string; args?: Record<string, unknown> };
        }[];
      };
    }[];
    modelVersion?: string;
  };

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const raw = parts.map((p) => p.text ?? "").join("");

  let functionCall: GeminiResult["functionCall"];
  for (const p of parts) {
    if (p.functionCall?.name) {
      functionCall = { name: p.functionCall.name, args: p.functionCall.args ?? {} };
      break;
    }
  }

  return {
    raw,
    functionCall,
    model: data.modelVersion ?? model,
    latencyMs: Date.now() - start,
  };
}
