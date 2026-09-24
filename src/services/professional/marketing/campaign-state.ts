export interface UnsentCampaignCheck {
  status: string;
  providerActionStartedAt: Date | null;
  providerSyncedAt: Date | null;
  nowMs?: number;
}

/** Keep external actions locked until provider state is stable after an ambiguous write. */
export function canResolveAsProviderDraft(input: UnsentCampaignCheck): boolean {
  if (input.status === "provider_review" || input.status === "unscheduling") return true;
  if (!["send_review", "sending", "scheduling"].includes(input.status)) return false;
  if (!input.providerActionStartedAt || !input.providerSyncedAt) return false;

  const now = input.nowMs ?? Date.now();
  const actionStartedAt = input.providerActionStartedAt.getTime();
  const lastVerifiedAt = input.providerSyncedAt.getTime();
  return actionStartedAt <= now - 5 * 60_000 &&
    lastVerifiedAt >= actionStartedAt &&
    lastVerifiedAt <= now - 2 * 60_000;
}
