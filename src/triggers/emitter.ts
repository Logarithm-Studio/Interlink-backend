/**
 * Trigger emitter — converts calendar/conflict changes into BullMQ jobs.
 *
 * Usage:
 *   await emitTrigger({ triggerType: TriggerType.CALENDAR_EVENT_UPSERTED, ... })
 *
 * The deterministic `jobId` coalesces bursts within the same 60-second bucket:
 *   trigger:emit:<triggerType>:<userId>:<entityId>:<bucket>
 *
 * BullMQ silently ignores a second `add()` with an already-queued/running jobId,
 * so rapid duplicate events (e.g. multiple webhooks for the same event update)
 * produce only one evaluation pass.
 */

import { randomUUID } from "crypto";
import { enqueueJob } from "../services/jobQueue.service";
import { JobType } from "../jobs/schemas/envelope";
import { TriggerPayload, TriggerType } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a stable entity identifier from the trigger payload.
 * Used as part of the dedup key to distinguish different calendar entities.
 */
function entityIdFromTrigger(trigger: TriggerPayload): string {
  switch (trigger.triggerType) {
    case TriggerType.CALENDAR_EVENT_UPSERTED:
    case TriggerType.CALENDAR_EVENT_DELETED:
      return trigger.event.externalEventId;
    case TriggerType.CALENDAR_CONFLICT_DETECTED:
      // Sorted join so A+B and B+A produce the same key.
      return [...trigger.conflict.conflictingEvents].sort().join("+");
  }
}

/**
 * Returns the current 60-second bucket as an integer.
 * Two triggers for the same entity within the same minute share the same key.
 */
function observedAtBucket(): number {
  return Math.floor(Date.now() / 60_000);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue a `trigger.emit` job for the given trigger payload.
 *
 * Safe to call from any service — it never throws on duplicate (BullMQ dedupe
 * is transparent).  The job is processed by the triggers worker which then
 * fans out to per-workflow `trigger.evaluate` jobs.
 */
export async function emitTrigger(trigger: TriggerPayload): Promise<void> {
  const entityId = entityIdFromTrigger(trigger);
  const bucket = observedAtBucket();

  const jobId = `trigger|emit|${trigger.triggerType}|${trigger.userId}|${entityId}|${bucket}`;

  const idempotencyKey = jobId;

  await enqueueJob(
    "triggers",
    {
      jobType: JobType.TRIGGER_EMIT,
      requestId: randomUUID(),
      idempotencyKey,
      userId: trigger.userId,
      payload: trigger as unknown as Record<string, unknown>,
    },
    { jobId, retries: 5 },
  );
}
