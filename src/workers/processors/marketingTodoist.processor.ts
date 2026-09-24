import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { PermanentJobError } from "../../jobs/errors";
import { logger } from "../../observability/logger";
import { syncMarketingTodoistFollowupsForUser } from "../../services/professional/marketing/leads.service";

export async function processMarketingTodoistSyncJob(body: unknown, jobId: string): Promise<void> {
  const parsed = JobEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new PermanentJobError(
      `Invalid marketing Todoist job envelope: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  if (parsed.data.jobType !== JobType.MARKETING_TODOIST_SYNC) {
    throw new PermanentJobError(`Unknown marketing Todoist job type: ${parsed.data.jobType}`);
  }
  const result = await syncMarketingTodoistFollowupsForUser(parsed.data.userId);
  logger.info("[marketing:todoist] scheduled reconciliation complete", {
    userId: parsed.data.userId, jobId, ...result,
  });
}
