import { query } from "../../../config/db";
import { AppError } from "../../../utils/errors";
import { enqueueJob } from "../../jobQueue.service";
import { JobType } from "../../../jobs/schemas/envelope";
import { getMarketingAnalyticsTargets, refreshMarketingAnalytics } from "./analytics.service";
import { hasMarketingAnalyticsRefreshTarget, marketingAnalyticsRefreshRange, type MarketingAnalyticsRefreshTargets } from "./analytics-schedule.model";

export interface MarketingAnalyticsRefreshPreference {
  enabled: boolean;
  targets: MarketingAnalyticsRefreshTargets;
  rangeDays: 30 | 90;
  lastRunAt: Date | null;
  lastResult: { refreshedProviders: string[]; failedProviders: string[] };
}

function parseTargets(value: unknown): MarketingAnalyticsRefreshTargets {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  return {
    ...(typeof row.ga4PropertyId === "string" ? { ga4PropertyId: row.ga4PropertyId } : {}),
    ...(typeof row.searchConsoleSite === "string" ? { searchConsoleSite: row.searchConsoleSite } : {}),
    ...(typeof row.facebookPageId === "string" ? { facebookPageId: row.facebookPageId } : {}),
    ...(typeof row.instagramUserId === "string" ? { instagramUserId: row.instagramUserId } : {}),
    ...(row.stripeBalance === true ? { stripeBalance: true } : {}),
    ...(typeof row.googleAdsCustomerId === "string" ? { googleAdsCustomerId: row.googleAdsCustomerId } : {}),
  };
}

function mapPreference(row: Record<string, unknown> | undefined): MarketingAnalyticsRefreshPreference {
  if (!row) return { enabled: false, targets: {}, rangeDays: 30, lastRunAt: null, lastResult: { refreshedProviders: [], failedProviders: [] } };
  const lastResult = row.last_result && typeof row.last_result === "object" && !Array.isArray(row.last_result)
    ? row.last_result as Record<string, unknown>
    : {};
  return {
    enabled: row.enabled === true,
    targets: parseTargets(row.targets),
    rangeDays: Number(row.range_days) === 90 ? 90 : 30,
    lastRunAt: row.last_run_at as Date | null,
    lastResult: {
      refreshedProviders: Array.isArray(lastResult.refreshedProviders) ? lastResult.refreshedProviders.filter((item): item is string => typeof item === "string") : [],
      failedProviders: Array.isArray(lastResult.failedProviders) ? lastResult.failedProviders.filter((item): item is string => typeof item === "string") : [],
    },
  };
}

export async function getMarketingAnalyticsRefreshPreference(userId: string): Promise<MarketingAnalyticsRefreshPreference> {
  const result = await query(
    `SELECT enabled,targets,range_days,last_run_at,last_result
       FROM sales_marketing_analytics_refresh_preferences WHERE user_id=$1`,
    [userId],
  );
  return mapPreference(result.rows[0] as Record<string, unknown> | undefined);
}

export async function saveMarketingAnalyticsRefreshPreference(userId: string, input: {
  enabled: boolean; targets: MarketingAnalyticsRefreshTargets; rangeDays: 30 | 90;
}): Promise<MarketingAnalyticsRefreshPreference> {
  if (input.enabled && !hasMarketingAnalyticsRefreshTarget(input.targets)) {
    throw new AppError("Choose at least one analytics account before enabling the daily refresh.", 400);
  }
  if (input.enabled) {
    const available = await getMarketingAnalyticsTargets(userId);
    const isAvailable = Boolean(
      (!input.targets.ga4PropertyId || available.ga4.properties.some((item) => item.ref === input.targets.ga4PropertyId))
      && (!input.targets.searchConsoleSite || available.searchConsole.sites.some((item) => item.ref === input.targets.searchConsoleSite))
      && (!input.targets.facebookPageId || available.facebook.pages.some((item) => item.ref === input.targets.facebookPageId))
      && (!input.targets.instagramUserId || available.instagram.accounts.some((item) => item.ref === input.targets.instagramUserId))
      && (!input.targets.googleAdsCustomerId || available.googleAds.accounts.some((item) => item.ref === input.targets.googleAdsCustomerId))
      && (!input.targets.stripeBalance || available.stripe.connected),
    );
    if (!isAvailable) throw new AppError("One or more selected analytics accounts are no longer available. Refresh the account list and choose them again.", 409);
  }
  const result = await query(
    `INSERT INTO sales_marketing_analytics_refresh_preferences(user_id,enabled,targets,range_days,updated_at)
     VALUES($1,$2,$3::jsonb,$4,now())
     ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,targets=EXCLUDED.targets,
       range_days=EXCLUDED.range_days,updated_at=now()
     RETURNING enabled,targets,range_days,last_run_at,last_result`,
    [userId, input.enabled, JSON.stringify(input.targets), input.rangeDays],
  );
  return mapPreference(result.rows[0] as Record<string, unknown>);
}

export async function dispatchMarketingAnalyticsRefreshes(now = new Date()): Promise<number> {
  const users = await query<{ user_id: string }>(
    `SELECT user_id FROM sales_marketing_analytics_refresh_preferences
      WHERE enabled=true AND targets <> '{}'::jsonb
      ORDER BY last_run_at ASC NULLS FIRST LIMIT 50`,
  );
  const day = now.toISOString().slice(0, 10);
  for (const row of users.rows) {
    const idempotencyKey = `marketing-analytics-refresh:${row.user_id}:${day}`;
    await enqueueJob("marketing-analytics-refresh", {
      jobType: JobType.MARKETING_ANALYTICS_REFRESH,
      idempotencyKey,
      userId: row.user_id,
      payload: {},
    }, { jobId: idempotencyKey, retries: 3 });
  }
  return users.rows.length;
}

async function saveRefreshResult(userId: string, refreshedProviders: string[], failedProviders: string[]): Promise<void> {
  await query(
    `UPDATE sales_marketing_analytics_refresh_preferences SET last_run_at=now(),
       last_result=$2::jsonb,updated_at=now() WHERE user_id=$1`,
    [userId, JSON.stringify({ refreshedProviders, failedProviders })],
  );
}

export async function runScheduledMarketingAnalyticsRefresh(userId: string, now = new Date()): Promise<{
  skipped: boolean; refreshedProviders: string[]; failedProviders: string[];
}> {
  const preference = await getMarketingAnalyticsRefreshPreference(userId);
  if (!preference.enabled || !hasMarketingAnalyticsRefreshTarget(preference.targets)) {
    return { skipped: true, refreshedProviders: [], failedProviders: [] };
  }
  const range = marketingAnalyticsRefreshRange(preference.rangeDays, now);
  try {
    const result = await refreshMarketingAnalytics(userId, { ...preference.targets, ...range });
    const failedProviders = result.failures.map((failure) => failure.provider);
    await saveRefreshResult(userId, result.refreshed, failedProviders);
    return { skipped: false, refreshedProviders: result.refreshed, failedProviders };
  } catch (error) {
    if (!(error instanceof AppError) || error.statusCode >= 500) throw error;
    const failedProviders = Object.entries(preference.targets).filter(([, selected]) => Boolean(selected)).map(([provider]) => provider);
    await saveRefreshResult(userId, [], failedProviders.length ? failedProviders : ["account_access"]);
    return { skipped: false, refreshedProviders: [], failedProviders: failedProviders.length ? failedProviders : ["account_access"] };
  }
}
