import { JobEnvelopeSchema } from "../../jobs/schemas/envelope";
import { recordAuditLog, buildEffectKey } from "../../security/idempotency";

export async function processDlqJob(
  rawData: unknown,
  jobId: string,
): Promise<void> {
  console.error(`[dlq] Dead job received | id=${jobId}`, { data: rawData });

  const envelope = JobEnvelopeSchema.safeParse(rawData);
  await recordAuditLog({
    userId: envelope.success ? envelope.data.userId : null,
    actorType: "worker",
    action: "job.dead_letter",
    idempotencyKey: buildEffectKey("job.dead_letter", jobId),
    requestId: envelope.success ? envelope.data.requestId : undefined,
    payload: { jobId, originalData: rawData },
  });
}
