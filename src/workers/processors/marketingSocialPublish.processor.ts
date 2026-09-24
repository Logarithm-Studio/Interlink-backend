import { z } from "zod";
import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { PermanentJobError } from "../../jobs/errors";
import { logger } from "../../observability/logger";
import { runScheduledMarketingSocialPublish } from "../../services/professional/marketing/social-scheduling.service";

const PayloadSchema = z.object({ scheduleId: z.string().uuid(), generation: z.number().int().positive() });

export async function processMarketingSocialPublishJob(body: unknown, jobId: string): Promise<void> {
  const parsed = JobEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new PermanentJobError(`Invalid Marketing scheduled publish envelope: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`);
  }
  if (parsed.data.jobType !== JobType.MARKETING_SOCIAL_PUBLISH) {
    throw new PermanentJobError(`Unknown Marketing scheduled publish job type: ${parsed.data.jobType}`);
  }
  const payload = PayloadSchema.safeParse(parsed.data.payload);
  if (!payload.success) {
    throw new PermanentJobError(`Invalid Marketing scheduled publish payload: ${payload.error.issues.map((issue) => issue.message).join(", ")}`);
  }
  const result = await runScheduledMarketingSocialPublish(parsed.data.userId, payload.data.scheduleId, payload.data.generation);
  logger.info("[marketing:social-publish] scheduled delivery handled", {
    userId: parsed.data.userId, scheduleId: payload.data.scheduleId, jobId, ...result,
  });
}
