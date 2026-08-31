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
const EXTERNAL_SOURCES = ["gmail", "slack", "github", "jira", "todoist"] as const;
export type ExternalSource = (typeof EXTERNAL_SOURCES)[number];

/**
 * Users we refresh: anyone with something the hub could produce a notification from.
 *
 * NOT `SELECT ... FROM push_tokens`. `runDailyDigestForAllUsers` used that as its "active
 * install" proxy, and copying it here was a bug worth recording: **`push_tokens` is empty in
 * this deployment**, so the fan-out silently did nothing for every user while every adapter
 * passed its own tests. The digest had been reaching nobody for the same reason; it now selects
 * the same population this function does. `push_tokens` appears below only as one more widening
 * `OR`, never as the source of the list.
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
 * Which users actually hold a credential for each external source.
 *
 * The fan-out used to be `every active user × every external source`, so a source was polled for
 * people who had never connected it. Each of those jobs did nothing but a token lookup and an
 * early return — but it still cost a real QStash message, and QStash is billed per message on a
 * daily quota. At 14 users that was 70 messages an hour (~1.7k/day) to do the work of about 20.
 *
 * `revoked` is excluded because the adapters themselves early-return on it. `reauth_required`
 * and `expired` are deliberately KEPT: the adapter is what writes `notification_source_health`,
 * and that row is what renders the "Reconnect" banner. Skipping lapsed users to save a message
 * would freeze the banner that tells them to fix the lapse.
 */
async function credentialHoldersBySource(): Promise<Record<ExternalSource, string[]>> {
  const holders = Object.fromEntries(
    EXTERNAL_SOURCES.map((src) => [src, [] as string[]]),
  ) as Record<ExternalSource, string[]>;

  // Gmail rides on Google OAuth, which has its own table rather than connected_integrations.
  const google = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM google_accounts`,
  );
  holders.gmail = google.rows.map((r) => r.user_id);

  const integrations = await query<{ provider: string; user_id: string }>(
    `SELECT DISTINCT provider, user_id
       FROM connected_integrations
      WHERE provider = ANY($1) AND status <> 'revoked'`,
    [EXTERNAL_SOURCES.filter((s) => s !== "gmail")],
  );
  for (const row of integrations.rows) {
    const source = row.provider as ExternalSource;
    if (holders[source]) holders[source].push(row.user_id);
  }

  return holders;
}

/**
 * Enqueue one job per external source per user who actually holds that credential.
 *
 * `jobId` is deterministic and bucketed by the hour, so a retried or double-fired schedule
 * within the same hour is deduplicated by QStash rather than double-polling Gmail.
 */
export async function dispatchExternalAdapters(): Promise<number> {
  const holders = await credentialHoldersBySource();
  const bucket = new Date().toISOString().slice(0, 13); // yyyy-mm-ddThh

  let enqueued = 0;
  for (const source of EXTERNAL_SOURCES) {
    for (const userId of holders[source]) {
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
    enqueued,
    bySource: Object.fromEntries(
      EXTERNAL_SOURCES.map((src) => [src, holders[src].length]),
    ),
  });
  return enqueued;
}
