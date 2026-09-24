import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { PermanentJobError } from "../../jobs/errors";
import { logger } from "../../observability/logger";
import { runScheduledMarketingPostMonitoring } from "../../services/professional/marketing/post-monitoring-schedule.service";

export async function processMarketingPostMonitorJob(body: unknown, jobId: string): Promise<void> {
  const parsed = JobEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new PermanentJobError(
      `Invalid Marketing post monitor envelope: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  if (parsed.data.jobType !== JobType.MARKETING_POST_MONITOR) {
    throw new PermanentJobError(`Unknown Marketing post monitor job type: ${parsed.data.jobType}`);
  }
  const result = await runScheduledMarketingPostMonitoring(parsed.data.userId);
  logger.info("[marketing:post-monitor] scheduled read-back complete", {
    userId: parsed.data.userId, jobId, ...result,
  });
}
