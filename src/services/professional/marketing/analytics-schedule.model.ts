export interface MarketingAnalyticsRefreshTargets {
  ga4PropertyId?: string;
  searchConsoleSite?: string;
  facebookPageId?: string;
  instagramUserId?: string;
  stripeBalance?: boolean;
  googleAdsCustomerId?: string;
}

export interface MarketingAnalyticsRefreshRange {
  startDate: string;
  endDate: string;
}

export function marketingAnalyticsRefreshRange(days: 30 | 90, now = new Date()): MarketingAnalyticsRefreshRange {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 3 * 86_400_000);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

export function hasMarketingAnalyticsRefreshTarget(targets: MarketingAnalyticsRefreshTargets): boolean {
  return Boolean(targets.ga4PropertyId || targets.searchConsoleSite || targets.facebookPageId
    || targets.instagramUserId || targets.stripeBalance || targets.googleAdsCustomerId);
}
