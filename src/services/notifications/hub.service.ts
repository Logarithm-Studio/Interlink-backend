/**
 * Notification Hub — the cross-app queue of things waiting on the user.
 *
 * This is the read/write core behind the bell, the Events widget, and the full notification
 * screen. Adapters (internal / gmail / calendar / ...) call `upsertItem`; the API layer calls
 * `getFeed`, `getUnreadCounts`, `resolveItem`, `dismissItem`.
 *
 * DESIGN CONSTRAINTS worth knowing before you change anything here:
 *
 * - **Actionable only.** A row means "if you do nothing, something bad or slow happens". Adapters
 *   enforce that bar; this service does not second-guess them, but do not relax it upstream —
 *   a mirror of nine apps' firehoses is the hassle relocated, not removed.
 *
 * - **Dedup keys are provider-scoped, not adapter-scoped.** A Gmail thread arriving from both the
 *   native adapter and a Composio trigger writes the same `gmail:<threadId>` and collapses into
 *   one row. That is why `upsertItem` is an upsert and not an insert.
 *
 * - **A dismissed item never resurrects.** The user dismissing something is a stronger statement
 *   than an adapter seeing it again on the next poll. Without this guard, every poll would undo
 *   every dismissal.
 *
 * - **Ordering is deterministic**, weight then recency, sharing `dailyDigest.service.ts`'s weight
 *   vocabulary so the digest and the feed can never disagree about what matters. The AI narrates
 *   this list once a day; it does not rank or route it.
 *
 * - **Preview text is encrypted at rest** with the existing keyring and stripped by the retention
 *   pass at 7 days. Rows outlive their text.
 */

import { query } from "../../config/db";
import { encryptToken, decryptToken } from "../integrations/tokenStore";
import { recordAuditLog } from "../../security/idempotency";
import { logger } from "../../observability/logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export type HubMode = "personal" | "professional";

export type HubSource =
  | "internal"
  | "gmail"
  | "calendar"
  | "slack"
  | "github"
  | "jira"
  | "todoist"
  | "composio";

export type HubState = "open" | "resolved" | "dismissed";

/**
 * Weight vocabulary — kept identical to `dailyDigest.service.ts` DigestLine weights on purpose.
 * If you add a weight here, add the matching digest line, or the two surfaces will start
 * disagreeing about what matters and the user will notice before you do.
 */
export const HUB_WEIGHTS = {
  meeting: 5,
  approval: 4,
  invoiceOverdue: 4,
  compliance: 3,
  showing: 3,
  leaseExpiring: 3,
  lead: 2,
  mail: 2,
  calendarChange: 3,
} as const;

export interface UpsertItemParams {
  userId: string;
  mode: HubMode;
  source: HubSource;
  kind: string;
  /** Provider-scoped and stable across runs, e.g. `gmail:<threadId>`, `internal:invoice:<id>`. */
  dedupKey: string;
  title: string;
  /** Stored encrypted; stripped by the retention pass after 7 days. */
  preview?: string | null;
  actor?: string | null;
  weight: number;
  externalRef?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface HubItem {
  id: string;
  mode: HubMode;
  source: HubSource;
  kind: string;
  title: string;
  preview: string | null;
  actor: string | null;
  weight: number;
  state: HubState;
  externalRef: Record<string, unknown>;
  occurredAt: string;
  /** True once the retention pass has stripped the preview — the row is a pointer now. */
  textPurged: boolean;
}

interface ItemRow {
  id: string;
  mode: HubMode;
  source: HubSource;
  kind: string;
  title: string;
  preview_packed: string | null;
  actor: string | null;
  weight: number;
  state: HubState;
  external_ref: Record<string, unknown>;
  occurred_at: Date;
  text_purged_at: Date | null;
}

// ─── Write ───────────────────────────────────────────────────────────────────

/**
 * Insert a hub item, or refresh it if the same `(userId, dedupKey)` already exists.
 *
 * Deliberately does NOT resurrect a dismissed row: the `WHERE` on the DO UPDATE means a
 * dismissed item stays dismissed no matter how many times an adapter re-observes it.
 */
export async function upsertItem(params: UpsertItemParams): Promise<void> {
  const packed =
    params.preview && params.preview.trim().length > 0
      ? encryptToken(truncatePreview(params.preview))
      : null;

  await query(
    `INSERT INTO notification_items
       (user_id, mode, source, kind, dedup_key, title, preview_packed, actor,
        weight, external_ref, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (user_id, dedup_key) DO UPDATE
       SET title          = EXCLUDED.title,
           preview_packed = EXCLUDED.preview_packed,
           actor          = EXCLUDED.actor,
           weight         = EXCLUDED.weight,
           external_ref   = EXCLUDED.external_ref,
           occurred_at    = EXCLUDED.occurred_at,
           text_purged_at = NULL,
           updated_at     = now()
       WHERE notification_items.state <> 'dismissed'`,
    [
      params.userId,
      params.mode,
      params.source,
      params.kind,
      params.dedupKey,
      params.title,
      packed,
      params.actor ?? null,
      params.weight,
      JSON.stringify(params.externalRef ?? {}),
      (params.occurredAt ?? new Date()).toISOString(),
    ],
  );
}

/** Preview text is a glance aid, not a copy of the message. Keep it short on purpose. */
function truncatePreview(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}

/**
 * Mark an item resolved because the source says so (e.g. the Gmail thread's newest message is
 * from the user — they already replied on their laptop). Distinct from a user dismissing it,
 * so the two never get conflated in the audit trail or the metric.
 */
export async function markResolvedBySource(
  userId: string,
  dedupKey: string,
): Promise<void> {
  await query(
    `UPDATE notification_items
        SET state = 'resolved', resolved_at = now(), updated_at = now()
      WHERE user_id = $1 AND dedup_key = $2 AND state = 'open'`,
    [userId, dedupKey],
  );
}

// ─── Read ────────────────────────────────────────────────────────────────────

export interface GetFeedParams {
  userId: string;
  mode: HubMode;
  /**
   * The Events widget passes `false`: the event list sits directly below it and would show the
   * same calendar items six inches apart. The full screen passes `true`.
   */
  includeCalendar: boolean;
  limit?: number;
}

export async function getFeed(params: GetFeedParams): Promise<HubItem[]> {
  const { userId, mode, includeCalendar, limit = 50 } = params;

  const res = await query<ItemRow>(
    `SELECT id, mode, source, kind, title, preview_packed, actor, weight, state,
            external_ref, occurred_at, text_purged_at
       FROM notification_items
      WHERE user_id = $1
        AND mode = $2
        AND state = 'open'
        AND ($3::boolean OR source <> 'calendar')
      ORDER BY weight DESC, occurred_at DESC
      LIMIT $4`,
    [userId, mode, includeCalendar, limit],
  );

  return res.rows.map(toHubItem);
}

function toHubItem(row: ItemRow): HubItem {
  return {
    id: row.id,
    mode: row.mode,
    source: row.source,
    kind: row.kind,
    title: row.title,
    preview: safeDecrypt(row.preview_packed),
    actor: row.actor,
    weight: row.weight,
    state: row.state,
    externalRef: row.external_ref ?? {},
    occurredAt: new Date(row.occurred_at).toISOString(),
    textPurged: row.text_purged_at !== null,
  };
}

/**
 * A preview that cannot be decrypted (rotated key, corrupt row) must not take down the whole
 * feed — the row is still useful as a pointer. Degrade to null and log.
 */
function safeDecrypt(packed: string | null): string | null {
  if (!packed) return null;
  try {
    return decryptToken(packed);
  } catch (err) {
    logger.warn("[hub] preview decrypt failed — serving row without preview", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Unread counts per mode. The bell shows a dot from this; the mode toggle shows the other side. */
export async function getUnreadCounts(
  userId: string,
): Promise<{ personal: number; professional: number }> {
  const res = await query<{ mode: HubMode; n: string }>(
    `SELECT mode, COUNT(*) n
       FROM notification_items
      WHERE user_id = $1 AND state = 'open'
      GROUP BY mode`,
    [userId],
  );

  const counts = { personal: 0, professional: 0 };
  for (const row of res.rows) {
    counts[row.mode] = parseInt(row.n, 10);
  }
  return counts;
}

// ─── User actions ────────────────────────────────────────────────────────────

export type ActionKind = "resolve" | "dismiss" | "opened_external";

/**
 * Record what the user did with an item.
 *
 * `opened_external` is the denominator of the success metric — the ratio of inline actions to
 * deep-links out. Without recording it we would only ever count the numerator and conclude the
 * hub was working no matter what people actually did.
 */
export async function recordAction(
  userId: string,
  itemId: string,
  action: ActionKind,
  requestId?: string,
): Promise<boolean> {
  const res = await query<{ id: string; source: HubSource; kind: string }>(
    `SELECT id, source, kind FROM notification_items WHERE id = $1 AND user_id = $2`,
    [itemId, userId],
  );
  const item = res.rows[0];
  if (!item) return false;

  if (action === "resolve" || action === "dismiss") {
    await query(
      `UPDATE notification_items
          SET state = $3, resolved_at = now(), updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [itemId, userId, action === "resolve" ? "resolved" : "dismissed"],
    );
  }

  await recordAuditLog({
    userId,
    actorType: "api",
    action: `notification_hub.${action}`,
    entityType: "notification_item",
    entityId: itemId,
    requestId: requestId ?? null,
    payload: { source: item.source, kind: item.kind },
  });

  return true;
}

// ─── Source health ───────────────────────────────────────────────────────────

export type SourceStatus = "ok" | "stale" | "reauth_required" | "error";

export interface SourceHealth {
  source: string;
  status: SourceStatus;
  lastOkAt: string | null;
  message: string | null;
}

export async function setSourceHealth(
  userId: string,
  source: HubSource,
  status: SourceStatus,
  message?: string | null,
): Promise<void> {
  await query(
    `INSERT INTO notification_source_health (user_id, source, status, last_ok_at, message)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'ok' THEN now() ELSE NULL END, $4)
     ON CONFLICT (user_id, source) DO UPDATE
       SET status     = EXCLUDED.status,
           message    = EXCLUDED.message,
           last_ok_at = CASE WHEN EXCLUDED.status = 'ok' THEN now()
                             ELSE notification_source_health.last_ok_at END,
           updated_at = now()`,
    [userId, source, status, message ?? null],
  );
}

export async function getSourceHealth(userId: string): Promise<SourceHealth[]> {
  const res = await query<{
    source: string;
    status: SourceStatus;
    last_ok_at: Date | null;
    message: string | null;
  }>(
    `SELECT source, status, last_ok_at, message
       FROM notification_source_health
      WHERE user_id = $1
      ORDER BY source`,
    [userId],
  );

  return res.rows.map((r) => ({
    source: r.source,
    status: r.status,
    lastOkAt: r.last_ok_at ? new Date(r.last_ok_at).toISOString() : null,
    message: r.message,
  }));
}

// ─── Cursors (pull adapters) ─────────────────────────────────────────────────

export async function getCursor(
  userId: string,
  source: HubSource,
): Promise<string | null> {
  const res = await query<{ cursor: string | null }>(
    `SELECT cursor FROM notification_source_cursors WHERE user_id = $1 AND source = $2`,
    [userId, source],
  );
  return res.rows[0]?.cursor ?? null;
}

export async function setCursor(
  userId: string,
  source: HubSource,
  cursor: string | null,
  success: boolean,
): Promise<void> {
  await query(
    `INSERT INTO notification_source_cursors
       (user_id, source, cursor, last_run_at, last_success_at)
     VALUES ($1, $2, $3, now(), CASE WHEN $4 THEN now() ELSE NULL END)
     ON CONFLICT (user_id, source) DO UPDATE
       SET cursor          = COALESCE(EXCLUDED.cursor, notification_source_cursors.cursor),
           last_run_at     = now(),
           last_success_at = CASE WHEN $4 THEN now()
                                  ELSE notification_source_cursors.last_success_at END,
           updated_at      = now()`,
    [userId, source, cursor, success],
  );
}
