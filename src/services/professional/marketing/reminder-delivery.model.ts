export type MarketingReminderChannel = "push" | "email";
export type MarketingReminderDeliveryStatus = "pending" | "sending" | "sent" | "failed" | "review";

/** A failed result is safe to retry; uncertain sends must be checked with the provider first. */
export function canRetryMarketingReminderDelivery(
  currentStatus: MarketingReminderDeliveryStatus,
  confirmedNotSent = false,
): boolean {
  return currentStatus === "failed" || (currentStatus === "review" && confirmedNotSent);
}

export function marketingReminderDeliveryKey(
  followupId: string,
  reminderAt: Date,
  channel: MarketingReminderChannel,
): string {
  return `marketing-followup:${followupId}:${reminderAt.getTime()}:${channel}`;
}
