import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { deliverNotification } from "../../services/notifications/notification.service";
import type { PushAction } from "../../services/notifications/push.service";

interface NotificationSendPayload {
  executionId: string;
  stepId: string;
  title: string;
  body: string;
  actions: PushAction[];
}

export async function processNotificationsJob(
  rawData: unknown,
  jobId: string,
): Promise<void> {
  const envelope = JobEnvelopeSchema.parse(rawData);

  switch (envelope.jobType) {
    case JobType.NOTIFICATION_SEND: {
      const p = envelope.payload as unknown as NotificationSendPayload;
      console.log(
        `[notifications] notification.send | user=${envelope.userId} | executionId=${p.executionId} | job=${jobId}`,
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
      console.warn(`[notifications] unknown jobType=${envelope.jobType} | job=${jobId}`);
  }
}
