import { randomUUID } from "crypto";
import { Worker, Job, UnrecoverableError } from "bullmq";
import { getConnection } from "../../queues/connection";
import { getCalendarSyncQueue } from "../../queues/queues";
import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import {
  incrementalSync,
  syncUserCalendar,
  FullResyncRequiredError,
} from "../../services/calendar/sync";
import { renewWatchChannel } from "../../services/calendar/googleWatch.service";
import { recordAuditLog, buildEffectKey } from "../../security/idempotency";

/**
 * Returns true if the error is a 4xx auth/permission failure.
 * These are permanent — retrying with the same credentials will not help.
 */
function isAuthError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status =
    (err as { status?: number }).status ??
    (err as { code?: number }).code ??
    (err as { response?: { status?: number } }).response?.status;
  return status === 401 || status === 403;
}

export function startCalendarSyncWorker(): Worker {
  const worker = new Worker(
    "calendar-sync",
    async (job: Job) => {
      const envelope = JobEnvelopeSchema.parse(job.data);

      try {
        switch (envelope.jobType) {
          case JobType.GOOGLE_SYNC: {
            const { channelId, calendarId } = envelope.payload as {
              channelId?: string;
              calendarId?: string;
            };

            console.log(
              `[calendar-sync] google.sync | user=${envelope.userId} | channel=${channelId ?? "n/a"} | job=${job.id}`,
            );

            if (!channelId) {
              // No watch-channel context (e.g. manual /sync route enqueued the job).
              // Fall back to a full sync without cursor tracking.
              const { synced, skipped, deleted } = await syncUserCalendar(
                envelope.userId,
                "google",
              );
              console.log(
                `[calendar-sync] done (no channel) | synced=${synced} skipped=${skipped} deleted=${deleted}`,
              );
              // Record durable audit entry for this sync effect.
              await recordAuditLog({
                userId: envelope.userId,
                actorType: "worker",
                action: "calendar.google.sync",
                idempotencyKey: buildEffectKey(
                  "google.sync",
                  envelope.idempotencyKey,
                ),
                requestId: envelope.requestId,
                payload: { synced, skipped, deleted, channelId: null },
              });
              break;
            }

            try {
              const { synced, skipped, deleted } = await incrementalSync(
                envelope.userId,
                channelId,
                calendarId ?? "primary",
              );
              console.log(
                `[calendar-sync] done | synced=${synced} skipped=${skipped} deleted=${deleted}`,
              );
              // Record durable audit entry for this incremental sync effect.
              await recordAuditLog({
                userId: envelope.userId,
                actorType: "worker",
                action: "calendar.google.sync",
                idempotencyKey: buildEffectKey(
                  "google.sync",
                  envelope.idempotencyKey,
                ),
                requestId: envelope.requestId,
                payload: { synced, skipped, deleted, channelId },
              });
            } catch (err) {
              if (err instanceof FullResyncRequiredError) {
                // syncToken was invalidated (410 Gone).  Cursor already cleared.
                // Enqueue a fresh GOOGLE_SYNC job; next run will full-sync and
                // re-seed the cursor.
                const resyncJobId = `google-sync-resync|${err.channelId}|${Date.now()}`;
                await getCalendarSyncQueue().add(
                  JobType.GOOGLE_SYNC,
                  {
                    jobType: JobType.GOOGLE_SYNC,
                    requestId: randomUUID(),
                    idempotencyKey: resyncJobId,
                    userId: err.userId,
                    payload: {
                      channelId: err.channelId,
                      calendarId: err.calendarId,
                    },
                  },
                  {
                    jobId: resyncJobId,
                    // Use the same retry policy as normal calendar sync jobs.
                    attempts: 8,
                    backoff: {
                      type: "calendar_exp" as "exponential",
                      delay: 30_000,
                    },
                  },
                );
                console.log(
                  `[calendar-sync] 410 Gone — enqueued full resync job ${resyncJobId}`,
                );
                break; // clean exit — the re-enqueued job will do the work
              }
              throw err; // unexpected error — let BullMQ retry
            }
            break;
          }

          case JobType.GOOGLE_WATCH_RENEW: {
            const { channelId } = envelope.payload as { channelId?: string };
            if (!channelId)
              throw new Error(
                "GOOGLE_WATCH_RENEW missing channelId in payload",
              );
            console.log(
              `[calendar-sync] google.watch.renew | channelId=${channelId} | job=${job.id}`,
            );
            const renewed = await renewWatchChannel(channelId);
            if (!renewed) {
              console.log(
                `[calendar-sync] channel ${channelId} no longer exists — skipping stale renewal job`,
              );
              break;
            }
            console.log(`[calendar-sync] channel ${channelId} renewed`);
            break;
          }

          case JobType.MICROSOFT_SYNC:
            // TODO (Step 14): run Microsoft Graph delta sync
            console.log(
              `[calendar-sync] microsoft.sync | user=${envelope.userId} | job=${job.id} — TODO Step 14`,
            );
            break;

          case JobType.MICROSOFT_SUBSCRIPTION_RENEW:
            // TODO (Step 14): renew Microsoft Graph subscription
            console.log(
              `[calendar-sync] microsoft.subscription.renew | user=${envelope.userId} | job=${job.id} — TODO Step 14`,
            );
            break;

          default:
            console.warn(`[calendar-sync] unknown jobType=${envelope.jobType}`);
        }
      } catch (err) {
        // 4xx auth errors are permanent — no point retrying with the same credentials.
        // Mark account as reauth-required and stop the retry chain.
        if (isAuthError(err)) {
          throw new UnrecoverableError(
            `calendar-sync: auth error (4xx) for user ${envelope.userId} — reauth required. ${(err as Error).message}`,
          );
        }
        throw err;
      }
    },
    {
      connection: getConnection(),
      concurrency: 5,
      settings: {
        // Cap exponential delay at 30 minutes (1 800 000 ms).
        backoffStrategy: (
          attemptsMade: number,
          type?: string,
          _err?: Error,
        ) => {
          if (type === "calendar_exp") {
            return Math.min(30_000 * Math.pow(2, attemptsMade - 1), 1_800_000);
          }
          return Math.pow(2, attemptsMade) * 5_000; // fallback
        },
      },
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[calendar-sync] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
