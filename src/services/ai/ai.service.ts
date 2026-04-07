/**
 * AI service — orchestrates LLM calls, schema validation, fallback, and audit.
 *
 * Public surface:
 * - `generateEmailDraft(params)` — generate a conflict email draft, with full
 *   idempotency, retry-safe fallback, and `ai_outputs` persistence.
 * - `computeAiIdempotencyKey(executionId, stepId, inputData)` — deterministic
 *   idempotency key for the step handler to pass in.
 *
 * Design constraints (from plan §8):
 * - JSON-only responses; hard Zod validation.
 * - Fallback template is deterministic and never calls the AI provider.
 * - Every invocation (including fallbacks) is persisted to `ai_outputs`.
 * - Every invocation writes an `audit_log` entry.
 * - Idempotency: repeat calls with the same key return the stored result.
 * - Rate limiting is the provider's concern at this layer; a Redis token bucket
 *   layer (Step 19) wraps overall usage.
 */

import { createHash } from "crypto";
import { query } from "../../config/db";
import { recordAuditLog } from "../../security/idempotency";
import { checkWorkerRateLimit } from "../../middleware/rateLimit";
import { getProvider } from "./provider";
import {
  EmailDraftSchema,
  EmailDraft,
  FallbackContext,
  buildFallbackEmailDraft,
} from "./schemas";
import {
  buildEmailConflictPrompt,
  ConflictEmailContext,
} from "./prompts/emailConflict";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AIGenerateEmailParams {
  executionId: string;
  stepId: string;
  userId: string;
  /**
   * Execution context (e.g. `execution.context.outputs` + trigger payload).
   * The service extracts conflict and event details from here.
   */
  contextData: Record<string, unknown>;
  /**
   * Deterministic idempotency key for this invocation.
   * Compute via `computeAiIdempotencyKey()`.
   */
  idempotencyKey: string;
}

export interface GenerateEmailResult {
  aiOutputId: string;
  emailDraft: EmailDraft;
  isFallback: boolean;
  model: string;
  provider: string;
  latencyMs: number;
}

// ─── Idempotency key ──────────────────────────────────────────────────────────

/**
 * Compute the canonical idempotency key for an `ai_generate_email` step.
 * Format (plan §15): `ai:email_draft:<executionId>:<stepId>:<inputHash>`
 * where `inputHash` is the first 16 hex chars of SHA-256 of the serialised
 * input context.
 */
export function computeAiIdempotencyKey(
  executionId: string,
  stepId: string,
  inputData: Record<string, unknown>,
): string {
  const inputHash = createHash("sha256")
    .update(JSON.stringify(inputData))
    .digest("hex")
    .slice(0, 16);
  return `ai:email_draft:${executionId}:${stepId}:${inputHash}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Safely read a string value from an object by checking multiple key names. */
function pickString(
  obj: Record<string, unknown> | undefined | null,
  ...keys: string[]
): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Extract a `ConflictEmailContext` from the execution's context data.
 *
 * The step can run from a trigger payload that looks like:
 * ```json
 * {
 *   "trigger": { "conflict": { "conflictingEventDetails": [...], ... } },
 *   "outputs": { "prior_step": { "emailRecipient": "..." } }
 * }
 * ```
 * We try to pull fields from multiple locations for resilience.
 */
function buildConflictContext(
  contextData: Record<string, unknown>,
  userEmail: string,
  recipientEmail?: string,
): ConflictEmailContext {
  // Conflict block may live at different depths depending on trigger structure.
  const triggerBlock = contextData.trigger as
    | Record<string, unknown>
    | undefined;
  const conflictBlock = (contextData.conflict ?? triggerBlock?.conflict) as
    | Record<string, unknown>
    | undefined;

  // Detailed event objects are populated when the conflicts.processor enriches
  // the trigger payload.  Fall back to a minimal description if absent.
  const details = (conflictBlock?.conflictingEventDetails ??
    contextData.conflictingEventDetails) as
    | Array<Record<string, unknown>>
    | undefined;

  const eventA = details?.[0] ?? {};
  const eventB = details?.[1] ?? {};

  const conflictType =
    (pickString(conflictBlock, "conflictType", "conflict_type") as
      | "overlap"
      | "buffer_violation"
      | undefined) ?? "overlap";

  const severity =
    (pickString(conflictBlock, "severity") as
      | "high"
      | "medium"
      | "low"
      | undefined) ?? "medium";

  const overlapMinutes =
    typeof conflictBlock?.overlapMinutes === "number"
      ? conflictBlock.overlapMinutes
      : 0;

  const meetingNotes =
    pickString(contextData, "meetingNotes", "meeting_notes", "notes") ??
    pickString(
      contextData.outputs as Record<string, unknown> | undefined,
      "meetingNotes",
      "meeting_notes",
      "notes",
    );

  const tonePreference =
    pickString(contextData, "tonePreference", "tone_preference", "tone") ??
    pickString(
      contextData.outputs as Record<string, unknown> | undefined,
      "tonePreference",
      "tone_preference",
      "tone",
    );

  return {
    eventATitle: pickString(eventA, "title") ?? "Event A",
    eventAStart:
      pickString(eventA, "startTime", "start_time") ?? "unknown time",
    eventAEnd: pickString(eventA, "endTime", "end_time") ?? "unknown time",
    eventBTitle: pickString(eventB, "title") ?? "Event B",
    eventBStart:
      pickString(eventB, "startTime", "start_time") ?? "unknown time",
    eventBEnd: pickString(eventB, "endTime", "end_time") ?? "unknown time",
    conflictType,
    overlapMinutes,
    severity,
    userEmail,
    recipientEmail,
    meetingNotes,
    tonePreference,
  };
}

// ─── Idempotency lookup ───────────────────────────────────────────────────────

async function findExisting(
  executionId: string,
  idempotencyKey: string,
): Promise<GenerateEmailResult | null> {
  const res = await query<{
    id: string;
    content: Record<string, unknown>;
    model: string;
    provider: string;
    latency_ms: number;
    is_fallback: boolean;
  }>(
    `SELECT id, content, model, provider, latency_ms, is_fallback
       FROM ai_outputs
      WHERE execution_id = $1
        AND idempotency_key = $2
        AND output_type = 'email_draft'
      LIMIT 1`,
    [executionId, idempotencyKey],
  );

  const row = res.rows[0];
  if (!row) return null;

  // Parse stored content back to EmailDraft (strip internal idempotency_key field).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { idempotency_key: _k, ...draftFields } = row.content;
  const parsed = EmailDraftSchema.safeParse(draftFields);
  if (!parsed.success) return null; // Corrupt row; allow regeneration.

  return {
    aiOutputId: row.id,
    emailDraft: parsed.data,
    isFallback: row.is_fallback,
    model: row.model ?? "",
    provider: row.provider ?? "",
    latencyMs: row.latency_ms ?? 0,
  };
}

// ─── Persist output ───────────────────────────────────────────────────────────

async function persistOutput(p: {
  executionId: string;
  idempotencyKey: string;
  draft: EmailDraft;
  model: string;
  provider: string;
  latencyMs: number;
  isFallback: boolean;
}): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO ai_outputs
          (execution_id, output_type, content, model, provider, latency_ms,
           is_fallback, idempotency_key)
     VALUES ($1, 'email_draft', $2::jsonb, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key)
       WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      p.executionId,
      JSON.stringify(p.draft),
      p.model,
      p.provider,
      p.latencyMs,
      p.isFallback,
      p.idempotencyKey,
    ],
  );

  // ON CONFLICT DO NOTHING means RETURNING is empty if already inserted.
  // Re-fetch if needed.
  if (res.rows[0]) return res.rows[0].id;

  const existing = await query<{ id: string }>(
    `SELECT id FROM ai_outputs WHERE idempotency_key = $1 LIMIT 1`,
    [p.idempotencyKey],
  );
  return existing.rows[0]?.id ?? "";
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate (or retrieve) an email draft for a calendar conflict.
 *
 * Flow:
 * 1. Idempotency check — return stored result if already processed.
 * 2. Load user email from `users` table (needed for prompt context).
 * 3. Extract conflict + event details from `contextData`.
 * 4. Call AI provider with structured prompt.
 * 5. Validate response with `EmailDraftSchema`; fall back on any failure.
 * 6. Persist to `ai_outputs` (ON CONFLICT DO NOTHING for concurrency safety).
 * 7. Write `audit_log` entry.
 * 8. Return `GenerateEmailResult`.
 */
export async function generateEmailDraft(
  params: AIGenerateEmailParams,
): Promise<GenerateEmailResult> {
  // ── 1. Idempotency check ──────────────────────────────────────────────────
  const existing = await findExisting(
    params.executionId,
    params.idempotencyKey,
  );
  if (existing) {
    console.log(
      `[ai.service] returning cached ai_output for key=${params.idempotencyKey}`,
    );
    return existing;
  }

  // ── 2. Load user email ────────────────────────────────────────────────────
  const userRes = await query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1 LIMIT 1",
    [params.userId],
  );
  const userEmail = userRes.rows[0]?.email ?? "user@example.com";

  // ── 3. Derive recipient (optional) ───────────────────────────────────────
  const recipientEmail =
    pickString(params.contextData, "recipientEmail", "recipient_email") ??
    pickString(
      params.contextData.outputs as Record<string, unknown> | undefined,
      "recipientEmail",
      "recipient_email",
    );

  // ── 4. Build conflict context ─────────────────────────────────────────────
  const conflictCtx = buildConflictContext(
    params.contextData,
    userEmail,
    recipientEmail,
  );

  // ── 5 & 6. Call provider + validate ──────────────────────────────────────
  let draft: EmailDraft;
  let model = "";
  let provider = "";
  let latencyMs = 0;
  let isFallback = false;

  // Per-user hard ceiling: default 20 AI calls / hour.
  // Configurable via AI_RATE_LIMIT_PER_USER_PER_HOUR env var.
  // Exceeding the ceiling skips the provider and uses the fallback template —
  // no cost, no retry, no error propagation to the workflow.
  const maxPerHour = parseInt(
    process.env.AI_RATE_LIMIT_PER_USER_PER_HOUR ?? "20",
    10,
  );
  const rlCheck = await checkWorkerRateLimit({
    bucketName: "ai-email-draft",
    identifier: params.userId,
    maxRequests: maxPerHour,
    windowMs: 60 * 60 * 1_000, // 1 hour
  });

  try {
    if (!rlCheck.allowed) {
      throw new Error(
        `AI_RATE_LIMITED: per-user ceiling of ${maxPerHour} calls/hour exceeded`,
      );
    }

    const aiProvider = getProvider();
    const { system, user } = buildEmailConflictPrompt(conflictCtx);

    const result = await aiProvider.generateText(system, user);
    model = result.model;
    provider = result.provider;
    latencyMs = result.latencyMs;

    // Must be valid JSON.
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.raw);
    } catch {
      throw new Error(
        `AI provider returned non-JSON output: ${result.raw.slice(0, 300)}`,
      );
    }

    // Must satisfy EmailDraftSchema.
    const validated = EmailDraftSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `AI output failed schema validation: ${validated.error.message}`,
      );
    }

    draft = validated.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[ai.service] generation failed — falling back to template. Reason: ${msg}`,
    );

    const fallbackCtx: FallbackContext = {
      eventATitle: conflictCtx.eventATitle,
      eventBTitle: conflictCtx.eventBTitle,
      conflictType: conflictCtx.conflictType,
      overlapMinutes: conflictCtx.overlapMinutes,
      recipientEmail: conflictCtx.recipientEmail,
      meetingNotes: conflictCtx.meetingNotes,
    };
    draft = buildFallbackEmailDraft(fallbackCtx);
    isFallback = true;
    model = "n/a";
    provider = process.env.AI_PROVIDER ?? "openai";
    latencyMs = 0;
  }

  // ── 7. Persist ──────────────────────────────────────────────────────────
  const aiOutputId = await persistOutput({
    executionId: params.executionId,
    idempotencyKey: params.idempotencyKey,
    draft,
    model,
    provider,
    latencyMs,
    isFallback,
  });

  // ── 8. Audit log (fire-and-forget; never blocks the caller) ─────────────
  recordAuditLog({
    userId: params.userId,
    actorType: "worker",
    action: "ai.email_draft.generate",
    entityType: "ai_output",
    entityId: aiOutputId || undefined,
    idempotencyKey: params.idempotencyKey,
    payload: {
      executionId: params.executionId,
      stepId: params.stepId,
      isFallback,
      model,
      provider,
      latencyMs,
    },
  }).catch((e) => {
    console.error("[ai.service] audit_log write failed:", e);
  });

  return {
    aiOutputId,
    emailDraft: draft,
    isFallback,
    model,
    provider,
    latencyMs,
  };
}
