/**
 * Notification Hub retention.
 *
 * The rule is STATE-BASED, not purely age-based, and that distinction is the whole point.
 * An invoice overdue 30 days is exactly what the user asked the hub to hold onto — deleting it
 * on day 8 because it is "old" would make the product lie about the one thing it promises.
 * Age only decides when the expensive, privacy-sensitive part (the preview text) goes.
 *
 *   1. Resolved / dismissed, older than 7d      -> delete outright. Nothing needs them.
 *   2. Open, older than 7d, still has text      -> strip the preview, keep the row as a pointer.
 *                                                  ~1KB becomes ~300 bytes.
 *   3. Open, older than 30d                     -> delete. Past this the item is either handled
 *                                                  elsewhere or was never really actionable.
 *
 * Sizing that motivated the tiering: ~20 items/user/day, ~1KB per full row. 100 users is ~14MB,
 * 10k users is ~1.4GB against a 500MB free tier. Pointer-only rows cut that to roughly a third.
 *
 * This is set-based SQL across all users, so a single scheduled tick is appropriate here.
 * Do NOT copy this shape for per-user adapter work — that must fan out one QStash job per user
 * per source, or it will blow a serverless timeout the moment there are several sources.
 */

import { query } from "../../config/db";
import { logger } from "../../observability/logger";

export interface RetentionResult {
  deletedResolved: number;
  textStripped: number;
  deletedStale: number;
}

const TEXT_TTL_DAYS = 7;
const RESOLVED_TTL_DAYS = 7;
const HARD_CEILING_DAYS = 30;

export async function runHubRetention(): Promise<RetentionResult> {
  // 1. Resolved and dismissed items have served their purpose.
  const resolved = await query(
    `DELETE FROM notification_items
      WHERE state IN ('resolved', 'dismissed')
        AND COALESCE(resolved_at, updated_at) < now() - ($1 || ' days')::interval`,
    [RESOLVED_TTL_DAYS],
  );

  // 2. Still open, but the text has aged out. The row survives — the user still needs to know
  //    the thing is waiting; they no longer need our copy of what it said.
  const stripped = await query(
    `UPDATE notification_items
        SET preview_packed = NULL,
            text_purged_at = now(),
            updated_at     = now()
      WHERE state = 'open'
        AND preview_packed IS NOT NULL
        AND occurred_at < now() - ($1 || ' days')::interval`,
    [TEXT_TTL_DAYS],
  );

  // 3. Hard ceiling. Something open for a month is not being actioned from here.
  const stale = await query(
    `DELETE FROM notification_items
      WHERE state = 'open'
        AND occurred_at < now() - ($1 || ' days')::interval`,
    [HARD_CEILING_DAYS],
  );

  const result: RetentionResult = {
    deletedResolved: resolved.rowCount ?? 0,
    textStripped: stripped.rowCount ?? 0,
    deletedStale: stale.rowCount ?? 0,
  };

  logger.info("[hub:retention] sweep complete", { ...result });
  return result;
}
