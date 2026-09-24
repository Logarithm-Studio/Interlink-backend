export type MarketingContentStatus = "draft" | "in_review" | "approved" | "planned" | "publishing" | "publish_review" | "published" | "completed" | "cancelled";

export function shouldResetMarketingContentApproval(
  status: MarketingContentStatus,
  hasSubstantiveEdit: boolean,
): boolean {
  return hasSubstantiveEdit && ["in_review", "approved", "planned"].includes(status);
}
