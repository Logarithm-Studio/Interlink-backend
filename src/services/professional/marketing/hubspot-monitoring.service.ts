import { query, withTransaction } from "../../../config/db";
import { JobType } from "../../../jobs/schemas/envelope";
import { AppError, NotFoundError } from "../../../utils/errors";
import { enqueueJob } from "../../jobQueue.service";
import { listConnections } from "../../composio/composio.service";
import { readMarketingHubSpotProviderFingerprints } from "./hubspot-sync.service";
import { changedHubSpotFields, mergeHubSpotReviewFields, type HubSpotMonitoredField } from "./hubspot-monitor.model";

const PROVIDER = "hubspot";
const CHECK_INTERVAL = "1 hour";
const MAX_USERS_PER_DISPATCH = 50;
const MAX_DEALS_PER_USER_RUN = 10;

export interface MarketingHubSpotMonitoringState {
  available: boolean;
  enabled: boolean;
  lastCheckedAt: Date | null;
  changedAt: Date | null;
  changedFields: HubSpotMonitoredField[];
  error: string | null;
}

export interface MarketingHubSpotConflict {
  dealId: string;
  dealTitle: string;
  contactName: string | null;
  company: string | null;
  stage: string;
  amountCents: number;
  currency: string;
  changedAt: Date;
  changedFields: HubSpotMonitoredField[];
}

export interface MarketingHubSpotResolution {
  dealId: string;
  dealTitle: string;
  resolvedAt: Date;
}

function mapState(row: Record<string, unknown> | undefined): MarketingHubSpotMonitoringState {
  if (!row) return { available: false, enabled: false, lastCheckedAt: null, changedAt: null, changedFields: [], error: null };
  const changeFields = Array.isArray(row.provider_change_fields) ? row.provider_change_fields as string[] : [];
  return {
    available: typeof row.external_record_id === "string" && row.external_record_id.length > 0,
    enabled: row.monitor_enabled === true,
    lastCheckedAt: row.provider_last_checked_at as Date | null,
    changedAt: row.provider_changed_at as Date | null,
    changedFields: mergeHubSpotReviewFields(changeFields, []),
    error: typeof row.provider_check_error === "string" ? row.provider_check_error : null,
  };
}

export async function getMarketingHubSpotMonitoring(userId: string, dealId: string): Promise<MarketingHubSpotMonitoringState> {
  const result = await query(
    `SELECT d.id,e.external_record_id,e.monitor_enabled,e.provider_last_checked_at,e.provider_changed_at,
            e.provider_change_fields,e.provider_check_error
       FROM sales_deals d
       LEFT JOIN sales_marketing_external_records e
         ON e.user_id=d.user_id AND e.provider=$3 AND e.record_type='deal' AND e.local_record_id=d.id
      WHERE d.id=$1 AND d.user_id=$2 AND (d.source='marketing' OR d.marketing_campaign_id IS NOT NULL)`,
    [dealId, userId, PROVIDER],
  );
  if (!result.rows[0]) throw new NotFoundError("Marketing opportunity");
  return mapState(result.rows[0] as Record<string, unknown>);
}

export async function listMarketingHubSpotConflicts(userId: string): Promise<MarketingHubSpotConflict[]> {
  const result = await query<{
    deal_id: string; title: string; contact_name: string | null; contact_company: string | null;
    stage: string; amount_cents: string | number; currency: string; changed_at: Date; changed_fields: string[];
  }>(
    `SELECT d.id AS deal_id,d.title,COALESCE(c.name,d.contact_name) AS contact_name,
            COALESCE(c.company,d.company) AS contact_company,d.stage,d.amount_cents,d.currency,
            e.provider_changed_at AS changed_at,e.provider_change_fields AS changed_fields
       FROM sales_marketing_external_records e
       JOIN sales_deals d ON d.id=e.local_record_id AND d.user_id=e.user_id
       LEFT JOIN sales_contacts c ON c.id=d.contact_id AND c.user_id=d.user_id
      WHERE e.user_id=$1 AND e.provider=$2 AND e.record_type='deal'
        AND e.monitor_enabled=true AND e.provider_changed_at IS NOT NULL
        AND cardinality(e.provider_change_fields)>0
        AND (d.source='marketing' OR d.marketing_campaign_id IS NOT NULL)
      ORDER BY e.provider_changed_at DESC,d.id LIMIT 100`,
    [userId, PROVIDER],
  );
  return result.rows.map((row) => ({
    dealId: row.deal_id,
    dealTitle: row.title,
    contactName: row.contact_name,
    company: row.contact_company,
    stage: row.stage,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    changedAt: row.changed_at,
    changedFields: mergeHubSpotReviewFields(row.changed_fields ?? [], []),
  }));
}

export async function listMarketingHubSpotResolutions(userId: string): Promise<MarketingHubSpotResolution[]> {
  const result = await query<{
    deal_id: string; title: string; resolved_at: Date;
  }>(
    `SELECT d.id AS deal_id,d.title,e.created_at AS resolved_at
       FROM sales_marketing_external_sync_events e
       JOIN sales_deals d ON d.id=e.local_record_id AND d.user_id=e.user_id
      WHERE e.user_id=$1 AND e.provider=$2 AND e.record_type='deal'
        AND e.operation='reconcile' AND e.outcome='success'
        AND e.detail LIKE 'Imported reviewed HubSpot fields:%'
        AND (d.source='marketing' OR d.marketing_campaign_id IS NOT NULL)
      ORDER BY e.created_at DESC,e.id DESC LIMIT 50`,
    [userId, PROVIDER],
  );
  return result.rows.map((row) => ({ dealId: row.deal_id, dealTitle: row.title, resolvedAt: row.resolved_at }));
}

export async function setMarketingHubSpotMonitoring(userId: string, dealId: string, enabled: boolean): Promise<MarketingHubSpotMonitoringState> {
  const current = await getMarketingHubSpotMonitoring(userId, dealId);
  if (enabled && !current.available) throw new AppError("Sync this marketing opportunity to HubSpot once before enabling automatic checks.", 409);
  let baseline: { fingerprints: Record<string, string>; keyId: string } | null = null;
  if (enabled) {
    const connected = (await listConnections(userId)).some((connection) =>
      connection.toolkitSlug === PROVIDER && connection.status === "active" && connection.connectedAccountId,
    );
    if (!connected) throw new AppError("Connect HubSpot before enabling automatic checks.", 409);
    baseline = await readMarketingHubSpotProviderFingerprints(userId, dealId);
  }
  const updated = await query(
    `UPDATE sales_marketing_external_records
        SET monitor_enabled=$4,
            provider_fingerprints=CASE WHEN $4 THEN $5::jsonb ELSE provider_fingerprints END,
            provider_fingerprint_key_id=CASE WHEN $4 THEN $6 ELSE provider_fingerprint_key_id END,
            provider_last_checked_at=CASE WHEN $4 THEN now() ELSE provider_last_checked_at END,
            provider_changed_at=CASE WHEN cardinality(provider_change_fields)>0 THEN COALESCE(provider_changed_at,now()) ELSE NULL END,
            provider_check_error=NULL,updated_at=now()
      WHERE user_id=$1 AND provider=$2 AND record_type='deal' AND local_record_id=$3 AND external_record_id IS NOT NULL
      RETURNING external_record_id,monitor_enabled,provider_last_checked_at,provider_changed_at,provider_change_fields,provider_check_error`,
    [userId, PROVIDER, dealId, enabled, JSON.stringify(baseline?.fingerprints ?? {}), baseline?.keyId ?? null],
  );
  if (!updated.rows[0]) throw new AppError("HubSpot mapping changed while saving its monitoring preference. Refresh and try again.", 409);
  return mapState(updated.rows[0] as Record<string, unknown>);
}

export async function dispatchMarketingHubSpotMonitoring(now = new Date()): Promise<number> {
  const users = await query<{ user_id: string }>(
    `SELECT user_id FROM sales_marketing_external_records
      WHERE provider=$1 AND record_type='deal' AND monitor_enabled=true AND external_record_id IS NOT NULL
        AND (provider_last_checked_at IS NULL OR provider_last_checked_at < now() - $2::interval)
        AND (provider_monitor_dispatched_at IS NULL OR provider_monitor_dispatched_at < now() - $2::interval)
      GROUP BY user_id ORDER BY min(provider_monitor_dispatched_at) ASC NULLS FIRST LIMIT $3`,
    [PROVIDER, CHECK_INTERVAL, MAX_USERS_PER_DISPATCH],
  );
  const hour = now.toISOString().slice(0, 13);
  for (const row of users.rows) {
    const idempotencyKey = `marketing-hubspot-monitor:${row.user_id}:${hour}`;
    await enqueueJob("marketing-hubspot-monitor", {
      jobType: JobType.MARKETING_HUBSPOT_MONITOR,
      idempotencyKey,
      userId: row.user_id,
      payload: {},
    }, { jobId: idempotencyKey, retries: 3 });
    await query(
      `UPDATE sales_marketing_external_records SET provider_monitor_dispatched_at=$2,updated_at=now()
        WHERE user_id=$1 AND provider=$3 AND record_type='deal' AND monitor_enabled=true AND external_record_id IS NOT NULL
          AND (provider_last_checked_at IS NULL OR provider_last_checked_at < $2 - $4::interval)`,
      [row.user_id, now, PROVIDER, CHECK_INTERVAL],
    );
  }
  return users.rows.length;
}

export async function runMarketingHubSpotMonitoring(userId: string, now = new Date()): Promise<{
  skipped: boolean; checked: number; changed: number; failed: number;
}> {
  const due = await query<{ local_record_id: string; provider_fingerprint_key_id: string | null }>(
    `SELECT local_record_id,provider_fingerprint_key_id FROM sales_marketing_external_records
      WHERE user_id=$1 AND provider=$2 AND record_type='deal' AND monitor_enabled=true AND external_record_id IS NOT NULL
        AND (provider_last_checked_at IS NULL OR provider_last_checked_at < $3 - $4::interval)
      ORDER BY provider_last_checked_at ASC NULLS FIRST,local_record_id ASC LIMIT $5`,
    [userId, PROVIDER, now, CHECK_INTERVAL, MAX_DEALS_PER_USER_RUN],
  );
  if (!due.rows.length) return { skipped: true, checked: 0, changed: 0, failed: 0 };

  let checked = 0;
  let changed = 0;
  let failed = 0;
  for (const row of due.rows) {
    try {
      const providerSnapshot = await readMarketingHubSpotProviderFingerprints(userId, row.local_record_id, row.provider_fingerprint_key_id ?? undefined);
      const result = await withTransaction(async (client) => {
        const current = await client.query<{ provider_fingerprints: Record<string, string>; provider_fingerprint_key_id: string | null; provider_change_fields: string[] }>(
          `SELECT provider_fingerprints,provider_fingerprint_key_id,provider_change_fields FROM sales_marketing_external_records
            WHERE user_id=$1 AND provider=$2 AND record_type='deal' AND local_record_id=$3 AND monitor_enabled=true FOR UPDATE`,
          [userId, PROVIDER, row.local_record_id],
        );
        if (!current.rows[0]) return { changed: false };
        const previous = current.rows[0].provider_fingerprints && typeof current.rows[0].provider_fingerprints === "object"
          ? current.rows[0].provider_fingerprints : {};
        const sameKey = current.rows[0].provider_fingerprint_key_id === providerSnapshot.keyId;
        const visibleFields = new Set(providerSnapshot.reviewFields);
        const freshFields = sameKey ? changedHubSpotFields(previous, providerSnapshot.fingerprints).filter((field) => visibleFields.has(field)) : [];
        const stillReviewable = (current.rows[0].provider_change_fields ?? []).filter((field) => visibleFields.has(field as HubSpotMonitoredField));
        const pendingFields = mergeHubSpotReviewFields(stillReviewable, freshFields);
        await client.query(
          `UPDATE sales_marketing_external_records
              SET provider_fingerprints=$4::jsonb,provider_fingerprint_key_id=$5,provider_change_fields=$6::text[],
                  provider_last_checked_at=$7,provider_changed_at=CASE WHEN cardinality($6::text[])>0 THEN COALESCE(provider_changed_at,$7) ELSE NULL END,
                  provider_check_error=NULL,updated_at=now()
            WHERE user_id=$1 AND provider=$2 AND record_type='deal' AND local_record_id=$3`,
          [userId, PROVIDER, row.local_record_id, JSON.stringify(providerSnapshot.fingerprints), providerSnapshot.keyId, pendingFields, now],
        );
        if (freshFields.length) {
          await client.query(
            `INSERT INTO sales_marketing_external_sync_events
               (user_id,provider,record_type,local_record_id,external_record_id,operation,outcome,detail)
             SELECT user_id,provider,record_type,local_record_id,external_record_id,'reconcile','review',$4
               FROM sales_marketing_external_records
              WHERE user_id=$1 AND provider=$2 AND record_type='deal' AND local_record_id=$3`,
            [userId, PROVIDER, row.local_record_id, `HubSpot changed monitored fields: ${freshFields.join(", ")}. Review before importing.`],
          );
        }
        return { changed: freshFields.length > 0 };
      });
      checked += 1;
      if (result.changed) changed += 1;
    } catch (error) {
      const safeError = error instanceof AppError ? error.message : "HubSpot could not be checked. Reconnect it or try again later.";
      await query(
        `UPDATE sales_marketing_external_records SET provider_last_checked_at=$4,provider_check_error=$5,updated_at=now()
          WHERE user_id=$1 AND provider=$2 AND record_type='deal' AND local_record_id=$3 AND monitor_enabled=true`,
        [userId, PROVIDER, row.local_record_id, now, safeError.slice(0, 1000)],
      );
      failed += 1;
    }
  }
  return { skipped: false, checked, changed, failed };
}
