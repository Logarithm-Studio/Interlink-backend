/**
 * AI provider abstraction.
 *
 * Exposes a single interface (`AIProvider`) so that the AI service is
 * decoupled from any specific vendor.
 *
 * Provider selection is **per mode** (Interlink v2 dual-core):
 *   - Personal Mode  → OpenAI   (env: AI_PROVIDER / AI_API_KEY / AI_MODEL)
 *   - Professional Mode → Gemini (env: PROFESSIONAL_AI_PROVIDER / GEMINI_API_KEY / GEMINI_MODEL)
 *
 * Call `getProvider({ mode })`.  The no-arg call defaults to personal/OpenAI so
 * existing personal-mode callers keep working unchanged.
 *
 * Adding another provider requires:
 *   1. A new class implementing `AIProvider`.
 *   2. A new branch in `resolveProvider()`.
 *   3. A new provider value in the env.
 *
 * Design constraints:
 * - Every call is JSON-only (OpenAI: response_format json_object; Gemini:
 *   generationConfig.responseMimeType = application/json).
 * - Temperature is fixed at 0 for deterministic outputs.
 * - A hard 30-second timeout is enforced per call; callers handle retries.
 * - One singleton per mode, lazy-initialized and reused.
 *
 * The Gemini implementation uses the REST API via global `fetch` (Node 20) so
 * no extra SDK dependency is required.
 */

import OpenAI from "openai";

export type AIMode = "personal" | "professional";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AIGenerationResult {
  /** Raw text returned by the provider.  Must be valid JSON. */
  raw: string;
  /** Model identifier as echoed by the provider (e.g. "gpt-4o-2024-08-06"). */
  model: string;
  /** Wall-clock latency for the provider call in milliseconds. */
  latencyMs: number;
  /** Provider name to persist in ai_outputs.provider. */
  provider: string;
}

export interface AIGenerateOptions {
  /**
   * Provider-native structured-output schema (JSON Schema subset). Gemini maps
   * it to `generationConfig.responseSchema`. Optional — Zod still validates.
   */
  responseSchema?: Record<string, unknown>;
  /** Max output tokens (default 1024). Insights/reports need more (e.g. 4096). */
  maxOutputTokens?: number;
}

export interface AIProvider {
  readonly name: string;
  /**
   * Ask the provider to return a JSON object.
   *
   * @param systemPrompt  Instruction block (schema description, constraints).
   * @param userPrompt    Per-call context (event data, conflict details).
   * @param opts          Optional structured-output schema + token budget.
   * @returns `AIGenerationResult` with raw JSON string.
   * @throws  On timeout, rate-limit, or provider error — caller handles fallback.
   */
  generateText(
    systemPrompt: string,
    userPrompt: string,
    opts?: AIGenerateOptions,
  ): Promise<AIGenerationResult>;
}

// ─── Demo implementation (no external calls) ────────────────────────────────

class DemoProvider implements AIProvider {
  readonly name = "demo";

  async generateText(): Promise<AIGenerationResult> {
    const start = Date.now();
    const raw = JSON.stringify({
      subject: "Demo email draft",
      body: "This is a demo email draft because AI_PROVIDER=demo.",
      reason: "Demo provider uses a fixed response.",
      proposed_times: [],
    });

    return {
      raw,
      model: "demo",
      latencyMs: Date.now() - start,
      provider: this.name,
    };
  }
}

// ─── OpenAI implementation ────────────────────────────────────────────────────

class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async generateText(
    systemPrompt: string,
    userPrompt: string,
    opts?: AIGenerateOptions,
  ): Promise<AIGenerationResult> {
    const start = Date.now();

    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: opts?.maxOutputTokens ?? 1024,
      },
      {
        timeout: 30_000, // 30 s hard timeout
      },
    );

    const raw = response.choices[0]?.message?.content ?? "";
    const model = response.model ?? this.model;

    return {
      raw,
      model,
      latencyMs: Date.now() - start,
      provider: "openai",
    };
  }
}

// ─── Gemini implementation (REST via fetch — no SDK dependency) ───────────────

class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generateText(
    systemPrompt: string,
    userPrompt: string,
    opts?: AIGenerateOptions,
  ): Promise<AIGenerationResult> {
    const start = Date.now();

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(this.model)}:generateContent?key=${this.apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0,
            maxOutputTokens: opts?.maxOutputTokens ?? 1024,
            ...(opts?.responseSchema
              ? { responseSchema: opts.responseSchema }
              : {}),
          },
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Gemini API error ${response.status}: ${errText.slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      modelVersion?: string;
    };

    const raw =
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("") ?? "";

    return {
      raw,
      model: data.modelVersion ?? this.model,
      latencyMs: Date.now() - start,
      provider: "gemini",
    };
  }
}

// ─── Factory (per-mode singletons) ────────────────────────────────────────────

const _singletons: Partial<Record<AIMode, AIProvider>> = {};

function resolveProvider(mode: AIMode): AIProvider {
  if (mode === "professional") {
    // Trim to avoid stray whitespace/CR characters from .env.
    const providerName = (process.env.PROFESSIONAL_AI_PROVIDER ?? "gemini")
      .toLowerCase()
      .trim();

    if (providerName === "demo") return new DemoProvider();

    if (providerName === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      const model = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
      if (!apiKey) {
        throw new Error(
          "GEMINI_API_KEY environment variable is required for Professional Mode " +
            "but not set. Add it to your .env file (or set PROFESSIONAL_AI_PROVIDER=demo).",
        );
      }
      return new GeminiProvider(apiKey, model);
    }

    // Allow professional mode to fall back to the OpenAI config if explicitly set.
    if (providerName === "openai") {
      const apiKey = process.env.AI_API_KEY;
      const model = process.env.AI_MODEL ?? "gpt-4o";
      if (!apiKey) {
        throw new Error("AI_API_KEY is required when PROFESSIONAL_AI_PROVIDER=openai.");
      }
      return new OpenAIProvider(apiKey, model);
    }

    throw new Error(
      `Unsupported PROFESSIONAL_AI_PROVIDER="${providerName}". ` +
        `Supported values: gemini, openai, demo`,
    );
  }

  // ── Personal mode (default) ──────────────────────────────────────────────
  const providerName = (process.env.AI_PROVIDER ?? "openai")
    .toLowerCase()
    .trim();

  if (providerName === "demo") return new DemoProvider();

  // Gemini for personal mode (PRD: "Gemini as universal brain").
  // Set AI_PROVIDER=gemini in .env to enable; GEMINI_API_KEY must be set.
  if (providerName === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY environment variable is required when AI_PROVIDER=gemini. " +
          "Add it to your .env file (or set AI_PROVIDER=openai).",
      );
    }
    return new GeminiProvider(apiKey, model);
  }

  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL ?? "gpt-4o";

  if (!apiKey) {
    throw new Error(
      "AI_API_KEY environment variable is required but not set. " +
        "Add it to your .env file.",
    );
  }

  if (providerName === "openai") return new OpenAIProvider(apiKey, model);

  throw new Error(
    `Unsupported AI_PROVIDER="${providerName}". Supported values: openai, gemini, demo`,
  );
}

/**
 * Return the configured AI provider singleton for the given mode.
 * Defaults to personal/OpenAI when no mode is supplied (back-compat).
 *
 * @throws If the required API key is not set or the provider is unsupported.
 */
export function getProvider(opts?: { mode?: AIMode }): AIProvider {
  const mode: AIMode = opts?.mode ?? "personal";
  const cached = _singletons[mode];
  if (cached) return cached;
  const provider = resolveProvider(mode);
  _singletons[mode] = provider;
  return provider;
}

/**
 * Override a provider singleton (test / DI use only).
 * Pass `null` to reset that mode to auto-initialization.
 */
export function setProvider(
  provider: AIProvider | null,
  mode: AIMode = "personal",
): void {
  if (provider) {
    _singletons[mode] = provider;
  } else {
    delete _singletons[mode];
  }
}
