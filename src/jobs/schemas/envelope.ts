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

  // Notification hub — one job per user per source (never one tick looping users).
  HUB_SOURCE_REFRESH: "hub.source.refresh",

  // Marketing Todoist reconciliation — one hourly account job per user.
  MARKETING_TODOIST_SYNC: "marketing.todoist.sync",

  // Marketing follow-up reminder fan-out — one bounded delivery job per user.
  MARKETING_FOLLOWUP_REMINDER: "marketing.followup.reminder",

  // Marketing analytics refresh — one daily read-only snapshot job per user.
  MARKETING_ANALYTICS_REFRESH: "marketing.analytics.refresh",

  // Marketing post monitoring — one daily opt-in social read-back job per user.
  MARKETING_POST_MONITOR: "marketing.post.monitor",

  // HubSpot CRM monitoring — opt-in read-only polling for mapped marketing deals.
  MARKETING_HUBSPOT_MONITOR: "marketing.hubspot.monitor",

  // Confirmed social publication scheduled by a marketer.
  MARKETING_SOCIAL_PUBLISH: "marketing.social.publish",
} as const;

export type JobTypeValue = (typeof JobType)[keyof typeof JobType];
