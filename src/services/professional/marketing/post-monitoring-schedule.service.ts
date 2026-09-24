import { query } from "../../../config/db";
import { JobType } from "../../../jobs/schemas/envelope";
import { AppError } from "../../../utils/errors";
import { enqueueJob } from "../../jobQueue.service";
import { listConnections } from "../../composio/composio.service";
import { checkMarketingPublishedPost } from "./post-monitoring.service";
import type { MarketingPostProvider } from "./post-monitoring.model";

const PROVIDERS: MarketingPostProvider[] = ["facebook", "instagram", "linkedin"];
const MAX_POSTS_PER_USER_PER_RUN = 10;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MarketingPostMonitoringPreference {
  enabled: boolean;
  providers: MarketingPostProvider[];
  lastRunAt: Date | null;
  lastResult: { checked: number; failed: number; failedProviders: MarketingPostProvider[] };
}

function normalizeProviders(value: unknown): MarketingPostProvider[] {
  if (!Array.isArray(value)) return [];
  return PROVIDERS.filter((provider) => value.includes(provider));
}

function mapPreference(row: Record<string, unknown> | undefined): MarketingPostMonitoringPreference {
  if (!row) return { enabled: false, providers: [], lastRunAt: null, lastResult: { checked: 0, failed: 0, failedProviders: [] } };
  const lastResult = row.last_result && typeof row.last_result === "object" && !Array.isArray(row.last_result)
    ? row.last_result as Record<string, unknown>
    : {};
  return {
    enabled: row.enabled === true,
    providers: normalizeProviders(row.providers),
    lastRunAt: row.last_run_at as Date | null,
    lastResult: {
      checked: Number.isSafeInteger(Number(lastResult.checked)) && Number(lastResult.checked) >= 0 ? Number(lastResult.checked) : 0,
      failed: Number.isSafeInteger(Number(lastResult.failed)) && Number(lastResult.failed) >= 0 ? Number(lastResult.failed) : 0,
      failedProviders: normalizeProviders(lastResult.failedProviders),
    },
  };
}

export async function getMarketingPostMonitoringPreference(userId: string): Promise<MarketingPostMonitoringPreference> {
  const result = await query(
    `SELECT enabled,providers,last_run_at,last_result
       FROM sales_marketing_post_monitor_preferences WHERE user_id=$1`,
    [userId],
  );
  return mapPreference(result.rows[0] as Record<string, unknown> | undefined);
}

export async function saveMarketingPostMonitoringPreference(userId: string, input: {
  enabled: boolean; providers: MarketingPostProvider[];
}): Promise<MarketingPostMonitoringPreference> {
  const providers = normalizeProviders(input.providers);
  if (input.enabled && providers.length === 0) {
    throw new AppError("Choose at least one connected social account before enabling automatic checks.", 400);
  }
  if (input.enabled) {
    const connections = await listConnections(userId);
    const activeProviders = new Set(connections
      .filter((connection) => connection.status === "active" && connection.connectedAccountId)
      .map((connection) => connection.toolkitSlug));
    if (providers.some((provider) => !activeProviders.has(provider))) {
      throw new AppError("One or more selected social accounts are no longer connected. Refresh connections and choose again.", 409);
    }
  }
  const result = await query(
    `INSERT INTO sales_marketing_post_monitor_preferences(user_id,enabled,providers,updated_at)
       VALUES($1,$2,$3::text[],now())
     ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,providers=EXCLUDED.providers,updated_at=now()
     RETURNING enabled,providers,last_run_at,last_result`,
    [userId, input.enabled, providers],
  );
  return mapPreference(result.rows[0] as Record<string, unknown>);
}

export async function dispatchMarketingPostMonitoring(now = new Date()): Promise<number> {
  const users = await query<{ user_id: string }>(
    `SELECT user_id FROM sales_marketing_post_monitor_preferences
      WHERE enabled=true AND cardinality(providers)>0
      ORDER BY last_run_at ASC NULLS FIRST LIMIT 50`,
  );
  const day = now.toISOString().slice(0, 10);
  for (const row of users.rows) {
    const idempotencyKey = `marketing-post-monitor:${row.user_id}:${day}`;
    await enqueueJob("marketing-post-monitor", {
      jobType: JobType.MARKETING_POST_MONITOR,
      idempotencyKey,
      userId: row.user_id,
      payload: {},
    }, { jobId: idempotencyKey, retries: 3 });
  }
  return users.rows.length;
}

export async function runScheduledMarketingPostMonitoring(userId: string, now = new Date()): Promise<{
  skipped: boolean; checked: number; failed: number; failedProviders: MarketingPostProvider[];
}> {
  const preference = await getMarketingPostMonitoringPreference(userId);
  if (!preference.enabled || preference.providers.length === 0) {
    return { skipped: true, checked: 0, failed: 0, failedProviders: [] };
  }

  const cutoff = new Date(now.getTime() - CHECK_INTERVAL_MS);
  const due = await query<{ id: string; provider: MarketingPostProvider }>(
    `SELECT c.id,c.provider
       FROM sales_marketing_content_items c
       LEFT JOIN LATERAL (
         SELECT MAX(s.checked_at) AS checked_at
           FROM sales_marketing_post_metrics_snapshots s
          WHERE s.user_id=c.user_id AND s.content_item_id=c.id
       ) latest ON true
      WHERE c.user_id=$1 AND c.status='published' AND c.provider=ANY($2::text[])
        AND c.provider_target_id IS NOT NULL AND length(btrim(c.provider_target_id))>0
        AND ((c.provider='facebook' AND c.provider_item_id ~ '^[0-9]{5,30}_[0-9]{1,40}$')
          OR (c.provider='instagram' AND c.provider_item_id ~ '^[0-9]{5,30}$')
          OR (c.provider='linkedin' AND c.provider_item_id ~ '^urn:li:(share|ugcPost):[A-Za-z0-9_-]+$'))
        AND (latest.checked_at IS NULL OR latest.checked_at < $3)
      ORDER BY COALESCE(latest.checked_at,c.published_at,c.updated_at) ASC,c.id ASC
      LIMIT ${MAX_POSTS_PER_USER_PER_RUN}`,
    [userId, preference.providers, cutoff],
  );

  let checked = 0;
  const failedProviders = new Set<MarketingPostProvider>();
  for (const item of due.rows) {
    try {
      await checkMarketingPublishedPost(userId, item.id);
      checked += 1;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      failedProviders.add(item.provider);
    }
  }
  const failed = due.rows.length - checked;
  const result = { checked, failed, failedProviders: [...failedProviders].sort() as MarketingPostProvider[] };
  await query(
    `UPDATE sales_marketing_post_monitor_preferences SET last_run_at=$2,last_result=$3::jsonb,updated_at=now()
      WHERE user_id=$1`,
    [userId, now, JSON.stringify(result)],
  );
  return { skipped: false, ...result };
}
