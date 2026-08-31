/**
 * Notification Hub scheduling — what the hourly tick actually does.
 *
 * THE FAN-OUT RULE: external adapters get **one QStash job per user per source**. They make
 * API calls with per-provider rate limits and multi-second latency, so looping every user inside
 * one HTTP request would blow a serverless timeout the moment there are more than a handful of
 * users or more than one source. `runDailyDigestForAllUsers` is written that way and is the
 * shape NOT to copy.
 *
 * The internal adapter is the deliberate exception: it is pure SQL over tables we already own,
 * with no network calls and no rate limits, so running it inline for everyone is both safe and
 * far cheaper than a job per user.
 */

import { query } from "../../config/db";
import { logger } from "../../observability/logger";
import { enqueueJob } from "../jobQueue.service";
import { JobType } from "../../jobs/schemas/envelope";
import { runInternalAdapter } from "./adapters/internal.adapter";
import { runCalendarAdapter } from "./adapters/calendar.adapter";

/** Sources that need a per-user job because they call an external API. */
const EXTERNAL_SOURCES = ["gmail", "slack", "github", "jira"] as const;
export type ExternalSource = (typeof EXTERNAL_SOURCES)[number];

/**
 * Users we refresh: anyone with something the hub could produce a notification from.
 *
 * NOT `push_tokens`. `runDailyDigestForAllUsers` uses that as its "active install" proxy, and
 * copying it here was a bug worth recording: **`push_tokens` is empty in this deployment**, so
 * the fan-out silently did nothing for every user while every adapter passed its own tests.
 * (It also means the daily digest currently reaches nobody — worth fixing separately.)
 *
 * A registered device is evidence someone can be *pushed to*. It is not evidence there is
 * anything to tell them, and the hub is a pull surface anyway: items must be waiting in the feed
 * whether or not a device ever registered. So the population is "has a connected account or
 * professional data", which is exactly who can have hub items.
 */
async function activeUserIds(): Promise<string[]> {
  const res = await query<{ id: string }>(
    `SELECT DISTINCT u.id
       FROM users u
      WHERE EXISTS (SELECT 1 FROM google_accounts g WHERE g.user_id = u.id)
         OR EXISTS (SELECT 1 FROM connected_integrations c WHERE c.user_id = u.id)
         OR EXISTS (SELECT 1 FROM invoices i WHERE i.user_id = u.id)
         OR EXISTS (SELECT 1 FROM re_leads r WHERE r.user_id = u.id)
         OR EXISTS (SELECT 1 FROM push_tokens p WHERE p.user_id = u.id)`,
  );
  return res.rows.map((r) => r.id);
}

/**
 * Local adapters for everyone, inline.
 *
 * Both the internal-signals and calendar adapters read only tables we already own — no network
 * calls, no provider rate limits — so a single pass over all users is both safe and far cheaper
 * than a job each. Anything that talks to an external API belongs in `dispatchExternalAdapters`.
 */
export async function runInternalAdapterForAllUsers(): Promise<number> {
  const users = await activeUserIds();

  let total = 0;
  for (const userId of users) {
    for (const [label, run] of [
      ["internal", runInternalAdapter],
      ["calendar", runCalendarAdapter],
    ] as const) {
      try {
        total += await run(userId);
      } catch (err) {
        logger.warn("[hub:local] user refresh failed — continuing", {
          err: err instanceof Error ? err.message : String(err),
          userId,
          adapter: label,
        });
      }
    }
  }

  logger.info("[hub:local] refresh complete", {
    users: users.length,
    items: total,
  });
  return total;
}

/**
 * Enqueue one job per user per external source.
 *
 * `jobId` is deterministic and bucketed by the hour, so a retried or double-fired schedule
 * within the same hour is deduplicated by QStash rather than double-polling Gmail.
 */
export async function dispatchExternalAdapters(): Promise<number> {
  const users = await activeUserIds();
  const bucket = new Date().toISOString().slice(0, 13); // yyyy-mm-ddThh

  let enqueued = 0;
  for (const userId of users) {
    for (const source of EXTERNAL_SOURCES) {
      try {
        await enqueueJob(
          "hub",
          {
            jobType: JobType.HUB_SOURCE_REFRESH,
            idempotencyKey: `hub:${source}:${userId}:${bucket}`,
            userId,
            payload: { source },
          },
          { jobId: `hub-${source}-${userId}-${bucket}` },
        );
        enqueued += 1;
      } catch (err) {
        logger.warn("[hub:dispatch] enqueue failed — continuing", {
          err: err instanceof Error ? err.message : String(err),
          userId,
          source,
        });
      }
    }
  }

  logger.info("[hub:dispatch] external adapter jobs enqueued", {
    users: users.length,
    enqueued,
  });
  return enqueued;
}
