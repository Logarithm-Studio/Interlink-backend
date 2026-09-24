import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { PermanentJobError } from "../../jobs/errors";
import { logger } from "../../observability/logger";
import { runScheduledMarketingAnalyticsRefresh } from "../../services/professional/marketing/analytics-schedule.service";

export async function processMarketingAnalyticsRefreshJob(body: unknown, jobId: string): Promise<void> {
  const parsed = JobEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new PermanentJobError(
      `Invalid marketing analytics refresh envelope: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  if (parsed.data.jobType !== JobType.MARKETING_ANALYTICS_REFRESH) {
    throw new PermanentJobError(`Unknown Marketing analytics refresh job type: ${parsed.data.jobType}`);
  }
  const result = await runScheduledMarketingAnalyticsRefresh(parsed.data.userId);
  logger.info("[marketing:analytics] scheduled refresh complete", {
    userId: parsed.data.userId, jobId, ...result,
  });
}
