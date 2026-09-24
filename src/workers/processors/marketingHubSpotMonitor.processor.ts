import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { PermanentJobError } from "../../jobs/errors";
import { logger } from "../../observability/logger";
import { runMarketingHubSpotMonitoring } from "../../services/professional/marketing/hubspot-monitoring.service";

export async function processMarketingHubSpotMonitorJob(body: unknown, jobId: string): Promise<void> {
  const parsed = JobEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new PermanentJobError(
      `Invalid Marketing HubSpot monitor envelope: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  if (parsed.data.jobType !== JobType.MARKETING_HUBSPOT_MONITOR) {
    throw new PermanentJobError(`Unknown Marketing HubSpot monitor job type: ${parsed.data.jobType}`);
  }
  const result = await runMarketingHubSpotMonitoring(parsed.data.userId);
  logger.info("[marketing:hubspot-monitor] read-only check complete", {
    userId: parsed.data.userId, jobId, ...result,
  });
}
