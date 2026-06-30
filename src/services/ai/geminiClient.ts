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
  | { inlineData: { mimeType: string; data: string } };

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

function geminiConfig(): { apiKey?: string; model: string; demo: boolean } {
  const providerName = (process.env.PROFESSIONAL_AI_PROVIDER ?? "gemini")
    .toLowerCase()
    .trim();
  const apiKey = process.env.GEMINI_API_KEY;
  return {
    apiKey,
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    demo: providerName === "demo" || !apiKey,
  };
}

/** True when a live Gemini call is possible (not demo, key present). */
export function isGeminiLive(): boolean {
  return !geminiConfig().demo;
}

// ─── REST call ────────────────────────────────────────────────────────────────

function toApiPart(p: GeminiPart): Record<string, unknown> {
  return "text" in p
    ? { text: p.text }
    : { inline_data: { mime_type: p.inlineData.mimeType, data: p.inlineData.data } };
}

export async function geminiGenerateContent(args: {
  system: string;
  parts: GeminiPart[];
  /** Force JSON output (default true). Ignored when `tools` are present. */
  json?: boolean;
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  tools?: GeminiToolFunction[];
  timeoutMs?: number;
}): Promise<GeminiResult> {
  const { apiKey, model, demo } = geminiConfig();
  if (demo || !apiKey) {
    throw new Error("Gemini is not configured (PROFESSIONAL_AI_PROVIDER=demo or no GEMINI_API_KEY)");
  }

  const start = Date.now();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const useJson = (args.json ?? true) && !args.tools;
  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    maxOutputTokens: args.maxOutputTokens ?? 2048,
  };
  if (useJson) {
    generationConfig.responseMimeType = "application/json";
    if (args.responseSchema) generationConfig.responseSchema = args.responseSchema;
  }

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: args.system }] },
    contents: [{ role: "user", parts: args.parts.map(toApiPart) }],
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
