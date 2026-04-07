import { Worker, Job } from "bullmq";
import { getConnection } from "../../queues/connection";
import { recordAuditLog, buildEffectKey } from "../../security/idempotency";
import { JobEnvelopeSchema } from "../../jobs/schemas/envelope";

/**
 * Dead-letter queue worker.
 * Receives jobs that have exhausted all retries.
 * Logs full context for manual inspection and replay tooling.
 */
export function startDlqWorker(): Worker {
  const worker = new Worker(
    "dlq",
    async (job: Job) => {
      console.error(
        `[dlq] Dead job received | id=${job.id} | name=${job.name}`,
        {
          data: job.data,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
        },
      );

      // Write a durable audit log entry for every permanently-failed job so
      // operators can trace and replay via the audit_log table.
      const envelope = JobEnvelopeSchema.safeParse(job.data);
      await recordAuditLog({
        userId: envelope.success ? envelope.data.userId : null,
        actorType: "worker",
        action: "job.dead_letter",
        idempotencyKey: buildEffectKey(
          "job.dead_letter",
          job.id ?? `dlq-${job.name}-${Date.now()}`,
        ),
        requestId: envelope.success ? envelope.data.requestId : undefined,
        payload: {
          jobId: job.id,
          jobName: job.name,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
          originalData: job.data,
        },
      });
    },
    { connection: getConnection(), concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    console.error(`[dlq] Failed to process dead job ${job?.id}:`, err.message);
  });

  return worker;
}
