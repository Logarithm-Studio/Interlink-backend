/**
 * The one-line daily narration above the feed.
 *
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO DO: it narrates an already-assembled, already-ordered
 * list. It never ranks, never routes, never decides what belongs in the feed. Ranking is
 * deterministic weights, because "did I miss something important" is precisely the question that
 * must not have a nondeterministic answer — and because a user who asks "why is this at the top"
 * deserves an explanation that exists.
 *
 * ONE GENERATION PER USER PER DAY, cached in `ai_outputs` under a date-stamped idempotency key,
 * and shared with the daily digest. Two surfaces narrating the same state must never contradict
 * each other, and a model call per surface would guarantee that eventually they do.
 *
 * FAILURE IS EXPECTED, not exceptional: no Gemini key, rate limit, timeout, bad JSON. Every path
 * falls back to a deterministic sentence built from the same weighted items. The feed is never
 * blocked on the model — the list is the product, the sentence is a courtesy.
 */

import { query } from "../../config/db";
import { logger } from "../../observability/logger";
import { geminiGenerateContent, isGeminiLive } from "../ai/geminiClient";
import { getFeed, type HubItem, type HubMode } from "./hub.service";

const OUTPUT_TYPE = "hub_daily_summary";

/** yyyy-mm-dd — the cache bucket. One narration per user per mode per day. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function cacheKey(userId: string, mode: HubMode): string {
  return `${OUTPUT_TYPE}:${userId}:${mode}:${today()}`;
}

/**
 * Deterministic fallback — and also the shape the model is asked to improve on.
 *
 * Deliberately plain. "3 things need you: two overdue invoices and a reply" is genuinely useful;
 * dressing it up would be the model's job, and when the model is unavailable, plain and correct
 * beats absent.
 */
export function deterministicSummary(items: HubItem[]): string {
  if (items.length === 0) return "Nothing needs you right now.";

  const byKind = new Map<string, number>();
  for (const item of items) {
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  }

  // Same KIND_LABEL map the model's tally uses, so the deterministic sentence and the generated
  // one name things identically — a user who sees the fallback one day and the model the next
  // should not think the vocabulary changed.
  const parts = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([kind, n]) => `${n} ${labelFor(kind, n)}`);

  const total = items.length;
  return `${total} ${total === 1 ? "thing needs" : "things need"} you — ${parts.join(", ")}.`;
}

async function readCache(key: string): Promise<string | null> {
  try {
    const res = await query<{ content: { summary?: string } }>(
      `SELECT content FROM ai_outputs
        WHERE idempotency_key = $1 AND output_type = $2
        LIMIT 1`,
      [key, OUTPUT_TYPE],
    );
    return res.rows[0]?.content?.summary ?? null;
  } catch {
    return null;
  }
}

async function writeCache(
  key: string,
  summary: string,
  meta: { model: string; provider: string; latencyMs: number; isFallback: boolean },
): Promise<void> {
  try {
    await query(
      `INSERT INTO ai_outputs
         (output_type, content, model, provider, latency_ms, is_fallback, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [
        OUTPUT_TYPE,
        JSON.stringify({ summary }),
        meta.model,
        meta.provider,
        meta.latencyMs,
        meta.isFallback,
        key,
      ],
    );
  } catch (err) {
    // A cache write failure must not cost the user their summary.
    logger.warn("[hub:summary] cache write failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

const SYSTEM_PROMPT = `You write ONE sentence summarising what is waiting for a busy professional.

You are given a TALLY with exact counts, already computed. Your job is phrasing, not arithmetic.

Rules:
- One sentence. Under 140 characters. No greeting, no sign-off, no emoji.
- Use ONLY the numbers in the tally, exactly as given. Never count the examples yourself, never
  add, never round, never estimate.
- Lead with whatever the tally lists first — it is already sorted by importance.
- Never invent an item, a name, an amount, or a deadline.
- Plain and calm. Do not use "exciting", "amazing", or exclamation marks. This person is busy,
  not being sold to.

Respond with the JSON object only. No preamble, no code fence.`;

/**
 * Human labels for a kind, singular and plural. Shared by the deterministic summary and the
 * tally handed to the model, so both surfaces name things identically.
 */
const KIND_LABEL: Record<string, [string, string]> = {
  invoice_overdue: ["overdue invoice", "overdue invoices"],
  approval_pending: ["approval waiting", "approvals waiting"],
  compliance_due: ["compliance item", "compliance items"],
  lead_followup: ["lead to follow up", "leads to follow up"],
  showing_upcoming: ["showing coming up", "showings coming up"],
  lease_expiring: ["lease ending", "leases ending"],
  gmail_thread: ["email", "emails"],
  calendar_cancelled: ["cancelled event", "cancelled events"],
  calendar_changed: ["moved event", "moved events"],
  calendar_conflict: ["calendar clash", "calendar clashes"],
};

function labelFor(kind: string, n: number): string {
  const pair = KIND_LABEL[kind];
  if (!pair) return kind.replace(/_/g, " ");
  return n === 1 ? pair[0] : pair[1];
}

/**
 * Counts per kind, highest weight first.
 *
 * Handing the model a computed tally instead of a list to count is the same trust boundary the
 * spreadsheet email flow settled on: the model describes, the code counts. Asking it to tally a
 * 15-line list produced "five compliance reviews" against four actual items — a fabricated
 * number in user-facing copy, which is exactly the failure this shape prevents.
 */
function buildTally(items: HubItem[]): { line: string; kinds: number } {
  const counts = new Map<string, { n: number; weight: number }>();
  for (const item of items) {
    const current = counts.get(item.kind);
    counts.set(item.kind, {
      n: (current?.n ?? 0) + 1,
      weight: Math.max(current?.weight ?? 0, item.weight),
    });
  }

  const ordered = [...counts.entries()].sort(
    (a, b) => b[1].weight - a[1].weight || b[1].n - a[1].n,
  );

  const line = ordered
    .map(([kind, { n }]) => `${n} ${labelFor(kind, n)}`)
    .join("; ");

  return { line, kinds: ordered.length };
}

/**
 * Tolerant extraction.
 *
 * Even with a response schema, models occasionally wrap the object in a ```json fence or prefix
 * a sentence of preamble. Parsing strictly turns a recoverable formatting quirk into a lost
 * summary, so strip the common wrappers before giving up.
 */
function extractSummary(raw: string): string | null {
  const candidates: string[] = [raw];

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);

  const braced = raw.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as { summary?: unknown };
      if (typeof parsed.summary === "string" && parsed.summary.trim()) {
        return parsed.summary.trim().slice(0, 200);
      }
    } catch {
      // Try the next candidate shape.
    }
  }
  return null;
}

/**
 * Narration for one user + mode. Cached; safe to call on every feed render.
 */
export async function getDailySummary(
  userId: string,
  mode: HubMode,
): Promise<{ summary: string; isFallback: boolean }> {
  const items = await getFeed({ userId, mode, includeCalendar: true, limit: 25 });
  const fallback = deterministicSummary(items);

  if (items.length === 0) return { summary: fallback, isFallback: true };

  const key = cacheKey(userId, mode);
  const cached = await readCache(key);
  if (cached) return { summary: cached, isFallback: false };

  if (!isGeminiLive()) {
    return { summary: fallback, isFallback: true };
  }

  try {
    const tally = buildTally(items);

    // Examples are for flavour (a real client name reads better than "a client"); the TALLY is
    // the source of truth for every number. The prompt says so explicitly.
    const examples = items
      .slice(0, 6)
      .map((i) => `- ${i.title}${i.actor ? ` (from ${i.actor})` : ""}`)
      .join("\n");

    const result = await geminiGenerateContent({
      system: SYSTEM_PROMPT,
      parts: [
        {
          text:
            `TALLY (exact counts, most important first): ${tally.line}\n` +
            `TOTAL ITEMS: ${items.length}\n\n` +
            `Examples of the underlying items (do not count these):\n${examples}`,
        },
      ],
      json: true,
      // Force the shape rather than asking for it — without this the model prefixed prose
      // ("Here is the JSON requested:") and opened a code fence.
      responseSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
      tier: "fast",
      // 2.5 "thinking" models draw thinking tokens from the SAME budget as maxOutputTokens
      // (documented in geminiClient.ts). At 200 with dynamic thinking the model thought itself
      // out of room and returned a truncated preamble. This is a one-sentence task: no thinking
      // budget, and enough headroom that truncation cannot happen.
      thinkingBudget: 0,
      maxOutputTokens: 512,
    });

    const summary = extractSummary(result.raw);
    if (!summary) {
      throw new Error(`model returned no usable summary: ${result.raw.slice(0, 120)}`);
    }

    await writeCache(key, summary, {
      model: result.model,
      provider: "gemini",
      latencyMs: result.latencyMs,
      isFallback: false,
    });

    return { summary, isFallback: false };
  } catch (err) {
    logger.warn("[hub:summary] generation failed — using deterministic summary", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { summary: fallback, isFallback: true };
  }
}
