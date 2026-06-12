/**
 * QStash-backed job queue — drop-in replacement for BullMQ queue.add() calls.
 *
 * Each call publishes an HTTP message to QStash, which will POST it back to
 * the corresponding /api/v1/workers/<queue> endpoint on this server.
 *
 * Deduplication: pass `jobId` to set the QStash deduplication ID.  QStash
 * silently discards messages with the same ID that arrive within the
 * deduplication window (default 24 hours), matching BullMQ's behaviour.
 *
 * Delayed delivery:
 *   - `delayMs`    — relative delay in milliseconds (converted to seconds)
 *   - `notBefore`  — absolute Date; QStash will not deliver before this time
 */

import { randomUUID } from "crypto";
import { getQStashClient } from "../config/qstash";
import { logger } from "../observability/logger";
import type { JobEnvelope } from "../jobs/schemas/envelope";

export type QueueName =
  | "calendar-sync"
  | "triggers"
  | "workflow"
  | "conflicts"
  | "notifications"
  | "email"
  | "dlq";

export interface EnqueueOptions {
  jobId?: string;
  delayMs?: number;
  notBefore?: Date;
  retries?: number;
}

export async function enqueueJob(
  queue: QueueName,
  envelope: Omit<JobEnvelope, "requestId"> & { requestId?: string },
  options: EnqueueOptions = {},
): Promise<void> {
  const baseUrl = (
    process.env.API_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined)
  )?.replace(/\/$/, "");

  if (!baseUrl) {
    throw new Error(
      "API_BASE_URL (or VERCEL_URL) must be set so QStash knows where to deliver jobs",
    );
  }

  const body: JobEnvelope = {
    requestId: randomUUID(),
    ...envelope,
  };

  const url = `${baseUrl}/api/v1/workers/${queue}`;

  const client = getQStashClient();

  let delaySec: number | undefined;
  if (options.notBefore) {
    const diffMs = options.notBefore.getTime() - Date.now();
    delaySec = Math.max(0, Math.ceil(diffMs / 1000));
  } else if (options.delayMs) {
    delaySec = Math.max(0, Math.ceil(options.delayMs / 1000));
  }

  try {
    await client.publishJSON({
      url,
      body,
      deduplicationId: options.jobId,
      delay: delaySec,
      retries: options.retries ?? 5,
    });
  } catch (err) {
    logger.error("Failed to enqueue job via QStash", {
      queue,
      jobType: envelope.jobType,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
