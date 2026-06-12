import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { PermanentJobError } from "../../jobs/errors";
import {
  createEmailDraft,
  ProviderNotConnectedError,
  AuthError,
} from "../../services/email/email.service";
import { recordAuditLog, buildEffectKey } from "../../security/idempotency";

export async function processEmailJob(
  rawData: unknown,
  jobId: string,
): Promise<void> {
  const envelope = JobEnvelopeSchema.parse(rawData);

  switch (envelope.jobType) {
    case JobType.EMAIL_DRAFT_CREATE: {
      const payload = envelope.payload as {
        executionId: string;
        stepId: string;
        recipient?: string;
        recipients?: string[];
        subject: string;
        body: string;
      };

      const resolvedRecipients: string[] = payload.recipients?.length
        ? payload.recipients
        : payload.recipient
          ? [payload.recipient]
          : [];

      if (!resolvedRecipients.length || !payload.subject || !payload.body) {
        throw new PermanentJobError(
          `email.draft.create: missing required fields (recipient/recipients, subject, body)`,
        );
      }

      try {
        const result = await createEmailDraft({
          executionId: payload.executionId ?? envelope.idempotencyKey,
          stepId: payload.stepId ?? "email-worker",
          userId: envelope.userId,
          recipients: resolvedRecipients,
          subject: payload.subject,
          body: payload.body,
        });

        await recordAuditLog({
          userId: envelope.userId,
          actorType: "worker",
          action: "email.draft.created",
          entityType: "email_draft",
          entityId: result.emailDraftId,
          idempotencyKey: buildEffectKey("email.draft.created", envelope.idempotencyKey),
          payload: {
            providerDraftId: result.providerDraftId,
            provider: result.provider,
            isNew: result.isNew,
            recipients: resolvedRecipients,
            subject: payload.subject,
          },
        });

        console.log(
          `[email] draft created | user=${envelope.userId} draftId=${result.emailDraftId} provider=${result.provider} isNew=${result.isNew} | job=${jobId}`,
        );
      } catch (err) {
        if (err instanceof ProviderNotConnectedError || err instanceof AuthError) {
          throw new PermanentJobError(
            `email.draft.create permanent failure: ${(err as Error).message}`,
          );
        }
        throw err;
      }
      break;
    }

    default:
      console.warn(`[email] unknown jobType=${envelope.jobType} | job=${jobId}`);
  }
}
