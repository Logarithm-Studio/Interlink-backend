import { z } from "zod";
import { JobEnvelopeSchema } from "../../jobs/schemas/envelope";
import { PermanentJobError } from "../../jobs/errors";
import { runEmailSequence } from "../../services/professional/marketing/email-sequence.service";
import { checkAgreementStatus } from "../../services/professional/marketing/agreement.service";

export async function processMarketingEmailSequence(body: unknown, _jobId: string): Promise<void> {
  const envelope = JobEnvelopeSchema.safeParse(body);
  if (!envelope.success || envelope.data.jobType !== "marketing.email.sequence") throw new PermanentJobError("Invalid Marketing email sequence envelope.");
  const payload = z.object({ sequenceId: z.string().uuid(), step: z.number().int().min(0).max(2) }).safeParse(envelope.data.payload);
  if (!payload.success) throw new PermanentJobError("Invalid Marketing email sequence payload.");
  await runEmailSequence(envelope.data.userId, payload.data.sequenceId, payload.data.step);
}

export async function processMarketingAgreementCheck(body:unknown,_jobId:string):Promise<void> {
  const envelope=JobEnvelopeSchema.safeParse(body);
  if(!envelope.success||envelope.data.jobType!=="marketing.agreement.check")throw new PermanentJobError("Invalid Marketing agreement check envelope.");
  const payload=z.object({agreementId:z.string().uuid()}).safeParse(envelope.data.payload);
  if(!payload.success)throw new PermanentJobError("Invalid agreement check payload.");
  await checkAgreementStatus(envelope.data.userId,payload.data.agreementId);
}
