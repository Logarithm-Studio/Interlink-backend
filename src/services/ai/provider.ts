/**
 * AI provider abstraction.
 *
 * Exposes a single interface (`AIProvider`) so that the AI service is
 * decoupled from any specific vendor.  Only OpenAI is wired up initially;
 * adding a second provider (Anthropic, Gemini, etc.) requires:
 *   1. A new class implementing `AIProvider`.
 *   2. A new branch in `getProvider()`.
 *   3. A new `AI_PROVIDER` value in the env.
 *
 * Design constraints:
 * - Every call is JSON-only (enforced by `response_format: { type: "json_object" }` on OpenAI).
 * - Temperature is fixed at 0 for deterministic outputs.
 * - A hard 30-second timeout is enforced per call; callers handle retries.
 * - The singleton is lazy-initialized once and reused.
 */

import OpenAI from "openai";

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

export interface AIProvider {
  readonly name: string;
  /**
   * Ask the provider to return a JSON object.
   *
   * @param systemPrompt  Instruction block (schema description, constraints).
   * @param userPrompt    Per-call context (event data, conflict details).
   * @returns `AIGenerationResult` with raw JSON string.
   * @throws  On timeout, rate-limit, or provider error — caller handles fallback.
   */
  generateText(
    systemPrompt: string,
    userPrompt: string,
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
        max_tokens: 1024,
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

// ─── Factory ──────────────────────────────────────────────────────────────────

let _singleton: AIProvider | null = null;

/**
 * Return the configured AI provider singleton.
 * Reads AI_PROVIDER, AI_API_KEY, and AI_MODEL from process.env.
 *
 * @throws If `AI_API_KEY` is not set.
 * @throws If `AI_PROVIDER` refers to an unsupported provider.
 */
export function getProvider(): AIProvider {
  if (_singleton) return _singleton;

  // Trim to avoid stray whitespace/CR characters from .env (e.g., "demo\r").
  const providerName = (process.env.AI_PROVIDER ?? "openai")
    .toLowerCase()
    .trim();
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL ?? "gpt-4o";

  if (providerName === "demo") {
    _singleton = new DemoProvider();
    return _singleton;
  }

  if (!apiKey) {
    throw new Error(
      "AI_API_KEY environment variable is required but not set. " +
        "Add it to your .env file.",
    );
  }

  if (providerName === "openai") {
    _singleton = new OpenAIProvider(apiKey, model);
    return _singleton;
  }

  throw new Error(
    `Unsupported AI_PROVIDER="${providerName}". ` +
      `Supported values: openai, demo`,
  );
}

/**
 * Override the provider singleton (test / DI use only).
 * Pass `null` to reset to auto-initialization.
 */
export function setProvider(provider: AIProvider | null): void {
  _singleton = provider;
}
