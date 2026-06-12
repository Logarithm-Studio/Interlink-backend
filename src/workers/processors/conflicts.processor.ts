import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { detectConflicts, persistConflicts } from "../../services/conflicts.service";
import { emitTrigger } from "../../triggers/emitter";
import { TriggerType } from "../../triggers/types";

export async function processConflictsJob(
  rawData: unknown,
  jobId: string,
): Promise<void> {
  const envelope = JobEnvelopeSchema.parse(rawData);

  switch (envelope.jobType) {
    case JobType.CONFLICTS_DETECT: {
      const { userId, rangeFrom, rangeTo } = envelope.payload as {
        userId: string;
        rangeFrom?: string;
        rangeTo?: string;
      };

      console.log(
        `[conflicts] conflicts.detect | user=${userId} range=[${rangeFrom ?? "default"}, ${rangeTo ?? "default"}] | job=${jobId}`,
      );

      const detected = await detectConflicts(userId, rangeFrom, rangeTo);
      const enriched = await persistConflicts(userId, detected);

      if (enriched.length === 0) {
        console.log(`[conflicts] No active conflicts | user=${userId}`);
        break;
      }

      console.log(`[conflicts] ${enriched.length} active conflict(s) persisted | user=${userId}`);

      const toEmit = enriched.filter((c) => c.isNew || c.severityChanged);
      if (toEmit.length === 0) {
        console.log(`[conflicts] All conflicts unchanged — no triggers emitted | user=${userId}`);
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
            console.error(
              `[conflicts] emitTrigger failed for conflict=${conflict.id}: ${(err as Error).message}`,
            );
          }
        }),
      );

      console.log(`[conflicts] ${toEmit.length} trigger(s) emitted | user=${userId}`);
      break;
    }

    default:
      console.warn(`[conflicts] unknown jobType=${envelope.jobType} | job=${jobId}`);
  }
}
