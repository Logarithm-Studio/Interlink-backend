export const SOCIAL_PUBLISH_QUEUE_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

/** Keep delayed messages inside QStash's documented free-tier maximum of seven days. */
export function isSocialPublishWithinQueueWindow(scheduledAt: Date, now = new Date()): boolean {
  return Number.isFinite(scheduledAt.getTime()) && scheduledAt.getTime() <= now.getTime() + SOCIAL_PUBLISH_QUEUE_WINDOW_MS;
}

export function socialPublishScheduleJobId(scheduleId: string, generation: number): string {
  return `marketing-social-publish:${scheduleId}:${generation}`;
}

export function canUnscheduleSocialPublish(status: string): boolean {
  return status === "pending" || status === "dispatching" || status === "queued";
}

/** QStash and the worker run on different clocks; a delivery this close to the slot is on time. */
export const SOCIAL_PUBLISH_CLOCK_SKEW_MS = 2 * 60_000;

export function isSocialPublishDue(scheduledAt: Date, now = new Date()): boolean {
  return scheduledAt.getTime() <= now.getTime() + SOCIAL_PUBLISH_CLOCK_SKEW_MS;
}
