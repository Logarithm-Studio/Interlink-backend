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
 * Poll one user's sources on demand, for pull-to-refresh.
 *
 * The feed endpoint only ever *read* stored rows, so nothing the user could do made the hub go
 * and look. Items appeared solely on the hourly tick, which meant a fresh connection showed an
 * empty hub for up to an hour and pull-to-refresh redisplayed the same stale list.
 *
 * Health rows are deliberately NOT cleared here: a manual refresh is not evidence the credential
 * was fixed, and blanking a genuine "Reconnect" banner on every pull would hide the one thing the
 * user needs to act on. Only an actual reconnect clears it.
 *
 * Bucketed to 5 minutes rather than 1: this is user-triggered and QStash bills per message, so
 * repeated pulls collapse instead of each buying a poll.
 */
export async function triggerUserHubRefresh(userId: string): Promise<string[]> {
  const holders = await credentialHoldersBySource();
  const bucket = new Date(Math.floor(Date.now() / 300_000) * 300_000)
    .toISOString()
    .slice(0, 16);

  const triggered: string[] = [];
  for (const source of EXTERNAL_SOURCES) {
    if (!holders[source].includes(userId)) continue;
    try {
      await enqueueJob(
        "hub",
        {
          jobType: JobType.HUB_SOURCE_REFRESH,
          idempotencyKey: `hub:manual:${source}:${userId}:${bucket}`,
          userId,
          payload: { source },
        },
        { jobId: `hub-manual-${source}-${userId}-${bucket}` },
      );
      triggered.push(source);
    } catch (err) {
      logger.warn("[hub:manual] enqueue failed", {
        userId,
        source,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Local adapters are pure SQL over our own tables, so they can run in this request.
  for (const [label, run] of [
    ["internal", runInternalAdapter],
    ["calendar", runCalendarAdapter],
  ] as const) {
    try {
      await run(userId);
      triggered.push(label);
    } catch (err) {
      logger.warn("[hub:manual] local adapter failed", {
        userId,
        adapter: label,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("[hub:manual] refresh triggered", { userId, triggered });
  return triggered;
}

/**
 * Refresh one user's hub right after they (re)connect an account.
 *
 * WHY THIS EXISTS. `notification_source_health` is written *only* by the adapters. Reconnecting
 * cleared `google_accounts.reauth_required` / `connected_integrations.status` but left the stale
 * `reauth_required` health row untouched, so the "Reconnect" banner kept showing for an account
 * that was already fixed, and no items arrived until the next hourly tick. Users reasonably read
 * that as "reconnecting did nothing".
 *
 * The stale rows are DELETED rather than set to `ok`: we do not yet know the source is healthy,
 * and claiming so would be a second lie. Absent means "no known problem, currently checking",
 * which is the truth until the adapter writes a real verdict moments later.
 *
 * The job id deliberately does NOT reuse the hourly bucket. That bucket exists to collapse a
 * double-fired schedule, but reusing it here would let an already-run hourly job swallow the
 * refresh the user just asked for. A minute bucket still guards against a reconnect loop
 * hammering the queue.
 */
export async function refreshHubAfterReconnect(
  userId: string,
  sources: readonly string[],
): Promise<void> {
  const external = sources.filter((s): s is ExternalSource =>
    (EXTERNAL_SOURCES as readonly string[]).includes(s),
  );

  try {
    await query(
      `DELETE FROM notification_source_health WHERE user_id = $1 AND source = ANY($2)`,
      [userId, [...sources]],
    );
  } catch (err) {
    logger.warn("[hub:reconnect] could not clear stale source health", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const minute = new Date().toISOString().slice(0, 16); // yyyy-mm-ddThh:mm
  for (const source of external) {
    try {
      await enqueueJob(
        "hub",
        {
          jobType: JobType.HUB_SOURCE_REFRESH,
          idempotencyKey: `hub:reconnect:${source}:${userId}:${minute}`,
          userId,
          payload: { source },
        },
        { jobId: `hub-reconnect-${source}-${userId}-${minute}` },
      );
    } catch (err) {
      logger.warn("[hub:reconnect] enqueue failed — hourly tick will catch it", {
        userId,
        source,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Calendar is pure SQL over our own tables, so it can run right now rather than waiting.
  if (sources.includes("calendar")) {
    try {
      await runCalendarAdapter(userId);
    } catch (err) {
      logger.warn("[hub:reconnect] inline calendar refresh failed", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("[hub:reconnect] refresh triggered", { userId, sources, external });
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
