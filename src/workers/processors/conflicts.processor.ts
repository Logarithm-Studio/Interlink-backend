/**
 * Conflicts worker — consumes `conflicts.detect` jobs, persists results to
 * the `conflicts` table, and emits `calendar.conflict.detected` triggers.
 *
 * Pipeline:
 *   1. detectConflicts()   — ephemeral SQL detection with buffer support
 *   2. persistConflicts()  — upsert active pairs, clear stale ones, return
 *                            enriched results with stable UUIDs + change flags
 *   3. emitTrigger()       — one trigger per NEW or severity-changed pair only
 *                            (suppresses repeated triggers for unchanged pairs)
 *
 * Trigger deduplication is enforced by emitTrigger (60-second bucket jobId).
 */

import { Worker, Job } from "bullmq";
import { getConnection } from "../../queues/connection";
import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import {
  detectConflicts,
  persistConflicts,
} from "../../services/conflicts.service";
import { emitTrigger } from "../../triggers/emitter";
import { TriggerType } from "../../triggers/types";

export function startConflictsWorker(): Worker {
  const worker = new Worker(
    "conflicts",
    async (job: Job) => {
      const envelope = JobEnvelopeSchema.parse(job.data);

      switch (envelope.jobType) {
        // ── conflicts.detect ──────────────────────────────────────────────────
        case JobType.CONFLICTS_DETECT: {
          const { userId, rangeFrom, rangeTo } = envelope.payload as {
            userId: string;
            rangeFrom?: string;
            rangeTo?: string;
          };

          console.log(
            `[conflicts] conflicts.detect | user=${userId} range=[${rangeFrom ?? "default"}, ${rangeTo ?? "default"}] | job=${job.id}`,
          );

          // Stage 1: ephemeral SQL detection.
          const detected = await detectConflicts(userId, rangeFrom, rangeTo);

          // Stage 2: persist to `conflicts` table — upsert active, clear stale.
          const enriched = await persistConflicts(userId, detected);

          if (enriched.length === 0) {
            console.log(
              `[conflicts] No active conflicts | user=${userId} | job=${job.id}`,
            );
            break;
          }

          console.log(
            `[conflicts] ${enriched.length} active conflict(s) persisted | user=${userId} | job=${job.id}`,
          );

          // Stage 3: emit triggers only for new or severity-changed pairs to
          // avoid flooding the workflow engine with repeat notifications.
          const toEmit = enriched.filter((c) => c.isNew || c.severityChanged);

          if (toEmit.length === 0) {
            console.log(
              `[conflicts] All conflicts unchanged — no triggers emitted | user=${userId}`,
            );
            break;
          }

          await Promise.all(
            toEmit.map(async (conflict) => {
              try {
                await emitTrigger({
                  triggerType: TriggerType.CALENDAR_CONFLICT_DETECTED,
                  userId,
                  conflict: {
                    conflictId: conflict.id,
                    conflictingEvents: [...conflict.conflictingEvents],
                    conflictType: conflict.conflictType,
                    severity: conflict.severity,
                    overlapMinutes: conflict.overlapMinutes,
                    isNew: conflict.isNew,
                    severityChanged: conflict.severityChanged,
                  },
                  observedAt: new Date().toISOString(),
                });
              } catch (err) {
                // A single trigger emit failure must not abort the whole batch.
                console.error(
                  `[conflicts] emitTrigger failed for conflict=${conflict.id} pair=(${conflict.conflictingEvents.join(",")}) | ${(err as Error).message}`,
                );
              }
            }),
          );

          console.log(
            `[conflicts] ${toEmit.length} trigger(s) emitted | user=${userId} | job=${job.id}`,
          );

          break;
        }

        default:
          console.warn(`[conflicts] unknown jobType=${envelope.jobType}`);
      }
    },
    { connection: getConnection(), concurrency: 5 },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[conflicts] job ${job?.id} failed (${job?.attemptsMade ?? 0} attempts): ${err.message}`,
    );
  });

  return worker;
}
