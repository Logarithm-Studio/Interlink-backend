import { randomUUID } from "crypto";
import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { PermanentJobError } from "../../jobs/errors";
import {
  incrementalSync,
  syncUserCalendar,
  FullResyncRequiredError,
} from "../../services/calendar/sync";
import { renewWatchChannel } from "../../services/calendar/googleWatch.service";
import { recordAuditLog, buildEffectKey } from "../../security/idempotency";
import { enqueueJob } from "../../services/jobQueue.service";

function isAuthError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status =
    (err as { status?: number }).status ??
    (err as { code?: number }).code ??
    (err as { response?: { status?: number } }).response?.status;
  return status === 401 || status === 403;
}

export async function processCalendarSyncJob(
  rawData: unknown,
  jobId: string,
): Promise<void> {
  const envelope = JobEnvelopeSchema.parse(rawData);

  try {
    switch (envelope.jobType) {
      case JobType.GOOGLE_SYNC: {
        const { channelId, calendarId } = envelope.payload as {
          channelId?: string;
          calendarId?: string;
        };

        console.log(
          `[calendar-sync] google.sync | user=${envelope.userId} | channel=${channelId ?? "n/a"} | job=${jobId}`,
        );

        if (!channelId) {
          const { synced, skipped, deleted } = await syncUserCalendar(
            envelope.userId,
            "google",
          );
          console.log(
            `[calendar-sync] done (no channel) | synced=${synced} skipped=${skipped} deleted=${deleted}`,
          );
          await recordAuditLog({
            userId: envelope.userId,
            actorType: "worker",
            action: "calendar.google.sync",
            idempotencyKey: buildEffectKey("google.sync", envelope.idempotencyKey),
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
          await recordAuditLog({
            userId: envelope.userId,
            actorType: "worker",
            action: "calendar.google.sync",
            idempotencyKey: buildEffectKey("google.sync", envelope.idempotencyKey),
            requestId: envelope.requestId,
            payload: { synced, skipped, deleted, channelId },
          });
        } catch (err) {
          if (err instanceof FullResyncRequiredError) {
            const resyncJobId = `google-sync-resync|${err.channelId}|${Date.now()}`;
            await enqueueJob(
              "calendar-sync",
              {
                jobType: JobType.GOOGLE_SYNC,
                requestId: randomUUID(),
                idempotencyKey: resyncJobId,
                userId: err.userId,
                payload: { channelId: err.channelId, calendarId: err.calendarId },
              },
              { jobId: resyncJobId, retries: 8 },
            );
            console.log(
              `[calendar-sync] 410 Gone — enqueued full resync job ${resyncJobId}`,
            );
            break;
          }
          throw err;
        }
        break;
      }

      case JobType.GOOGLE_WATCH_RENEW: {
        const { channelId } = envelope.payload as { channelId?: string };
        if (!channelId) {
          throw new PermanentJobError("GOOGLE_WATCH_RENEW missing channelId in payload");
        }
        console.log(
          `[calendar-sync] google.watch.renew | channelId=${channelId} | job=${jobId}`,
        );
        const renewed = await renewWatchChannel(channelId);
        if (!renewed) {
          console.log(
            `[calendar-sync] channel ${channelId} no longer exists — skipping stale renewal job`,
          );
        } else {
          console.log(`[calendar-sync] channel ${channelId} renewed`);
        }
        break;
      }

      case JobType.MICROSOFT_SYNC:
        console.log(
          `[calendar-sync] microsoft.sync | user=${envelope.userId} | job=${jobId} — TODO Step 14`,
        );
        break;

      case JobType.MICROSOFT_SUBSCRIPTION_RENEW:
        console.log(
          `[calendar-sync] microsoft.subscription.renew | user=${envelope.userId} | job=${jobId} — TODO Step 14`,
        );
        break;

      default:
        console.warn(`[calendar-sync] unknown jobType=${envelope.jobType}`);
    }
  } catch (err) {
    if (isAuthError(err)) {
      throw new PermanentJobError(
        `calendar-sync: auth error (4xx) for user ${envelope.userId} — reauth required. ${(err as Error).message}`,
      );
    }
    throw err;
  }
}
