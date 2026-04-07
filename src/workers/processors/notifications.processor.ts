import { Worker, Job } from "bullmq";
import { getConnection } from "../../queues/connection";
import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { deliverNotification } from "../../services/notifications/notification.service";
import type { PushAction } from "../../services/notifications/push.service";

// ─── Payload shape for NOTIFICATION_SEND jobs ─────────────────────────────────

interface NotificationSendPayload {
  executionId: string;
  stepId: string;
  title: string;
  body: string;
  actions: PushAction[];
}

export function startNotificationsWorker(): Worker {
  const worker = new Worker(
    "notifications",
    async (job: Job) => {
      const envelope = JobEnvelopeSchema.parse(job.data);

      switch (envelope.jobType) {
        case JobType.NOTIFICATION_SEND: {
          const p = envelope.payload as unknown as NotificationSendPayload;
          console.log(
            `[notifications] notification.send | user=${envelope.userId} | executionId=${p.executionId} | job=${job.id}`,
          );
          await deliverNotification({
            executionId: p.executionId,
            stepId: p.stepId,
            userId: envelope.userId,
            title: p.title,
            body: p.body,
            actions: p.actions ?? [],
          });
          break;
        }

        default:
          console.warn(`[notifications] unknown jobType=${envelope.jobType}`);
      }
    },
    { connection: getConnection(), concurrency: 10 },
  );

  worker.on("failed", (job, err) => {
    console.error(`[notifications] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
