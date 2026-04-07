import { z } from "zod";

/**
 * Standard envelope wrapping every BullMQ job payload.
 * All producers must conform to this schema.
 * All processors must validate incoming data against this schema.
 */
export const JobEnvelopeSchema = z.object({
  jobType: z.string().min(1),
  requestId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
  userId: z.string().uuid(),
  payload: z.record(z.unknown()).default({}),
});

export type JobEnvelope = z.infer<typeof JobEnvelopeSchema>;

// ─── Job type constants ────────────────────────────────────────────────────

export const JobType = {
  // Calendar sync
  GOOGLE_SYNC: "calendar.google.sync",
  GOOGLE_WATCH_RENEW: "calendar.google.watch.renew",
  MICROSOFT_SYNC: "calendar.microsoft.sync",
  MICROSOFT_SUBSCRIPTION_RENEW: "calendar.microsoft.subscription.renew",

  // Triggers
  TRIGGER_EMIT: "trigger.emit",
  TRIGGER_EVALUATE: "trigger.evaluate",

  // Workflow
  WORKFLOW_RUN: "workflow.run",
  WORKFLOW_RESUME: "workflow.resume",
  WORKFLOW_TIMEOUT: "workflow.timeout",

  // Conflicts
  CONFLICTS_DETECT: "conflicts.detect",

  // Notifications
  NOTIFICATION_SEND: "notification.send",

  // Email
  EMAIL_DRAFT_CREATE: "email.draft.create",
} as const;

export type JobTypeValue = (typeof JobType)[keyof typeof JobType];
