import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { PermanentJobError } from "../../jobs/errors";
import { logger } from "../../observability/logger";
import { dispatchDueMarketingFollowupRemindersForUser } from "../../services/professional/marketing/leads.service";

export async function processMarketingFollowupReminderJob(body: unknown, jobId: string): Promise<void> {
  const parsed = JobEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new PermanentJobError(
      `Invalid marketing follow-up reminder envelope: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  if (parsed.data.jobType !== JobType.MARKETING_FOLLOWUP_REMINDER) {
    throw new PermanentJobError(`Unknown marketing follow-up reminder job type: ${parsed.data.jobType}`);
  }
  const processed = await dispatchDueMarketingFollowupRemindersForUser(parsed.data.userId);
  logger.info("[marketing:followup-reminder] scheduled delivery pass complete", {
    userId: parsed.data.userId, jobId, processed,
  });
}
