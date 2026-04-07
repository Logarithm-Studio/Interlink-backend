import { Worker, Job, UnrecoverableError } from "bullmq";
import { getConnection } from "../../queues/connection";
import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import {
  createEmailDraft,
  ProviderNotConnectedError,
  AuthError,
} from "../../services/email/email.service";
import { recordAuditLog, buildEffectKey } from "../../security/idempotency";

export function startEmailWorker(): Worker {
  const worker = new Worker(
    "email",
    async (job: Job) => {
      const envelope = JobEnvelopeSchema.parse(job.data);

      switch (envelope.jobType) {
        case JobType.EMAIL_DRAFT_CREATE: {
          const payload = envelope.payload as {
            executionId: string;
            stepId: string;
            /** Single recipient (legacy) or array of recipients. */
            recipient?: string;
            recipients?: string[];
            subject: string;
            body: string;
          };

          // Support both the legacy single-recipient field and the new array form.
          const resolvedRecipients: string[] = payload.recipients?.length
            ? payload.recipients
            : payload.recipient
              ? [payload.recipient]
              : [];

          if (!resolvedRecipients.length || !payload.subject || !payload.body) {
            throw new UnrecoverableError(
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

            // Audit trail
            await recordAuditLog({
              userId: envelope.userId,
              actorType: "worker",
              action: "email.draft.created",
              entityType: "email_draft",
              entityId: result.emailDraftId,
              idempotencyKey: buildEffectKey(
                "email.draft.created",
                envelope.idempotencyKey,
              ),
              payload: {
                providerDraftId: result.providerDraftId,
                provider: result.provider,
                isNew: result.isNew,
                recipients: resolvedRecipients,
                subject: payload.subject,
              },
            });

            console.log(
              `[email] draft created | user=${envelope.userId} draftId=${result.emailDraftId} ` +
                `provider=${result.provider} isNew=${result.isNew}`,
            );
          } catch (err) {
            // Permanent failures — don't retry
            if (
              err instanceof ProviderNotConnectedError ||
              err instanceof AuthError
            ) {
              throw new UnrecoverableError(
                `email.draft.create permanent failure: ${(err as Error).message}`,
              );
            }
            throw err;
          }
          break;
        }

        default:
          console.warn(`[email] unknown jobType=${envelope.jobType}`);
      }
    },
    { connection: getConnection(), concurrency: 3 },
  );

  worker.on("failed", (job, err) => {
    console.error(`[email] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
