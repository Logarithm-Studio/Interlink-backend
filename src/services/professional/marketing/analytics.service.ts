import { query } from "../../../config/db";
import { executeComposioTool, listConnections } from "../../composio/composio.service";
import { AppError } from "../../../utils/errors";
import { getMarketingPublishTargets } from "./social-publishing.service";

type JsonObject = Record<string, unknown>;

export interface MarketingAnalyticsTarget {
  ref: string;
  name: string;
}

export interface MarketingAnalyticsTargets {
  ga4: { connected: boolean; properties: MarketingAnalyticsTarget[]; error: string | null };
  searchConsole: { connected: boolean; sites: MarketingAnalyticsTarget[]; error: string | null };
  facebook: { connected: boolean; pages: MarketingAnalyticsTarget[]; error: string | null };
  instagram: { connected: boolean; accounts: MarketingAnalyticsTarget[]; error: string | null };
  stripe: { connected: boolean; account: MarketingAnalyticsTarget | null; error: string | null };
  googleAds: { connected: boolean; accounts: MarketingAnalyticsTarget[]; error: string | null };
}

export interface MarketingAnalyticsSnapshot {
  id: string;
  provider: "ga4" | "search_console" | "facebook_page" | "instagram_account" | "stripe_balance" | "google_ads_campaign";
  accountRef: string;
  accountName: string;
  rangeStart: string;
  rangeEnd: string;
  metrics: JsonObject;
  fetchedAt: Date;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function unwrap(value: unknown): JsonObject {
  let current = object(value);
  for (let depth = 0; depth < 4; depth += 1) {
    const next = current.response_data ?? current.responseData ?? current.data ?? current.result;
    if (!next || typeof next !== "object" || Array.isArray(next)) break;
    current = object(next);
  }
  return current;
}

function findArray(value: unknown, keys: string[], depth = 0): unknown[] {
  if (depth > 5) return [];
  const current = object(value);
  for (const key of keys) if (Array.isArray(current[key])) return current[key] as unknown[];
  for (const nested of Object.values(current)) {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const found = findArray(nested, keys, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

function successfulData(result: { ok: boolean; message: string; data?: unknown }, providerName: string): JsonObject {
  if (!result.ok) throw new AppError(result.message || `${providerName} could not return analytics.`, 502);
  return unwrap(result.data);
}

function connected(toolkit: string, connections: Awaited<ReturnType<typeof listConnections>>): boolean {
  return connections.some((connection) => connection.toolkitSlug === toolkit && connection.status === "active" && connection.connectedAccountId);
}

type MarketingAnalyticsSource = "ga4" | "search_console" | "facebook_page" | "instagram_account" | "stripe_balance" | "google_ads_campaign";

const GOOGLE_ADS_MAX_MANAGER_ACCOUNTS = 50;
const GOOGLE_ADS_MAX_ACCOUNTS = 200;
const GOOGLE_ADS_MAX_PAGES_PER_MANAGER = 10;
const GOOGLE_ADS_MAX_MANAGER_DEPTH = 5;
const GOOGLE_ADS_DISCOVERY_CONCURRENCY = 5;
const GOOGLE_ADS_TARGET_CACHE_TTL_MS = 5 * 60_000;
const googleAdsTargetCache = new Map<string, { fetchedAt: number; result: { accounts: MarketingAnalyticsTarget[]; truncated: boolean } }>();
const googleAdsTargetLoads = new Map<string, Promise<{ accounts: MarketingAnalyticsTarget[]; truncated: boolean }>>();
const GOOGLE_ADS_MAX_CAMPAIGN_ROWS = 500;
const SEARCH_CONSOLE_DIMENSION_ROW_LIMIT = 500;
const SEARCH_CONSOLE_DISPLAY_ROW_LIMIT = 100;

type MarketingComposioResult = { ok: boolean; message: string; data?: unknown };
type MarketingComposioExecutor = (toolName: string, args: Record<string, unknown>) => Promise<MarketingComposioResult>;

function googleAdsCustomerId(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.match(/(?:customers\/)?(\d{7,20})$/)?.[1];
    return normalized ?? null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = object(value);
  for (const key of ["customerId", "customer_id", "id", "resourceName", "resource_name"]) {
    const field = row[key];
    if (typeof field !== "string") continue;
    const id = googleAdsCustomerId(field);
    if (id) return id;
  }
  return null;
}

function googleAdsRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return findArray(value, ["resourceNames", "resource_names", "accessibleCustomers", "accessible_customers", "customerIds", "customer_ids", "customers", "subAccounts", "sub_accounts", "accounts"]);
}

function nextPageToken(value: JsonObject): string | null {
  const token = value.nextPageToken ?? value.next_page_token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

export async function loadGoogleAdsAnalyticsAccounts(execute: MarketingComposioExecutor): Promise<{ accounts: MarketingAnalyticsTarget[]; truncated: boolean }> {
  const accessibleResult = await execute("GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS", {});
  const accessible = successfulData(accessibleResult, "Google Ads");
  const roots = [...new Set(googleAdsRows(accessible).map(googleAdsCustomerId).filter((id): id is string => Boolean(id)))];
  const accounts = new Map<string, MarketingAnalyticsTarget>();
  const managerQueue = roots.slice(0, GOOGLE_ADS_MAX_MANAGER_ACCOUNTS).map((id) => ({ id, name: `Google Ads ${id}`, depth: 0 }));
  const queuedManagers = new Set(managerQueue.map((manager) => manager.id));
  let managersVisited = 0;
  let truncated = roots.length > GOOGLE_ADS_MAX_MANAGER_ACCOUNTS;

  while (managerQueue.length > 0 && managersVisited < GOOGLE_ADS_MAX_MANAGER_ACCOUNTS && accounts.size < GOOGLE_ADS_MAX_ACCOUNTS) {
    const batchSize = Math.min(GOOGLE_ADS_DISCOVERY_CONCURRENCY, GOOGLE_ADS_MAX_MANAGER_ACCOUNTS - managersVisited);
    const batch = managerQueue.splice(0, batchSize);
    managersVisited += batch.length;
    const discoveries = await Promise.all(batch.map(async (manager) => {
      let pageToken: string | undefined;
      let childrenFound = false;
      const children: MarketingAnalyticsTarget[] = [];
      const childManagers: Array<{ id: string; name: string; depth: number }> = [];
      let pageCapReached = false;
      for (let page = 0; page < GOOGLE_ADS_MAX_PAGES_PER_MANAGER; page += 1) {
        const result = await execute("GOOGLEADS_LIST_SUB_ACCOUNTS", { customer_id: manager.id, ...(pageToken ? { page_token: pageToken } : {}) });
        if (!result.ok) {
          // A normal client account may not expose the manager listing. It is still a valid
          // reporting target, so leave it selectable and surface provider errors on refresh.
          break;
        }
        const data = successfulData(result, "Google Ads");
        const rows = googleAdsRows(data);
        if (!rows.length) break;
        childrenFound = true;
        for (const rowValue of rows) {
          const row = object(rowValue);
          const id = googleAdsCustomerId(rowValue);
          if (!id) continue;
          const nameValue = row.descriptiveName ?? row.descriptive_name ?? row.name;
          const name = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : `Google Ads ${id}`;
          if (row.manager === true) {
            if (manager.depth + 1 >= GOOGLE_ADS_MAX_MANAGER_DEPTH) pageCapReached = true;
            else childManagers.push({ id, name, depth: manager.depth + 1 });
          } else {
            children.push({ ref: id, name });
          }
        }
        const token = nextPageToken(data);
        if (!token) break;
        if (page === GOOGLE_ADS_MAX_PAGES_PER_MANAGER - 1) pageCapReached = true;
        pageToken = token;
      }
      return { manager, childrenFound, children, childManagers, pageCapReached };
    }));

    for (const discovery of discoveries) {
      truncated ||= discovery.pageCapReached;
      for (const child of discovery.children) {
        accounts.set(child.ref, child);
        if (accounts.size >= GOOGLE_ADS_MAX_ACCOUNTS) { truncated = true; break; }
      }
      for (const childManager of discovery.childManagers) {
        if (queuedManagers.has(childManager.id)) continue;
        queuedManagers.add(childManager.id);
        managerQueue.push(childManager);
      }
      if (!discovery.childrenFound && !accounts.has(discovery.manager.id)) {
        accounts.set(discovery.manager.id, { ref: discovery.manager.id, name: discovery.manager.name });
      }
      if (accounts.size >= GOOGLE_ADS_MAX_ACCOUNTS) break;
    }
  }

  if (managerQueue.length > 0) truncated = true;
  return { accounts: [...accounts.values()].sort((left, right) => left.name.localeCompare(right.name)), truncated };
}

async function cachedGoogleAdsAnalyticsAccounts(userId: string, execute: MarketingComposioExecutor): Promise<{ accounts: MarketingAnalyticsTarget[]; truncated: boolean }> {
  const cached = googleAdsTargetCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < GOOGLE_ADS_TARGET_CACHE_TTL_MS) return cached.result;
  const inFlight = googleAdsTargetLoads.get(userId);
  if (inFlight) return inFlight;
  const request = loadGoogleAdsAnalyticsAccounts(execute).then((result) => {
    googleAdsTargetCache.set(userId, { fetchedAt: Date.now(), result });
    if (googleAdsTargetCache.size > 500) {
      const oldestUserId = googleAdsTargetCache.keys().next().value;
      if (oldestUserId) googleAdsTargetCache.delete(oldestUserId);
    }
    return result;
  });
  googleAdsTargetLoads.set(userId, request);
  try { return await request; }
  finally { if (googleAdsTargetLoads.get(userId) === request) googleAdsTargetLoads.delete(userId); }
}

export async function getMarketingAnalyticsTargets(userId: string, only?: ReadonlySet<MarketingAnalyticsSource>): Promise<MarketingAnalyticsTargets> {
  const shouldFetch = (source: MarketingAnalyticsSource) => !only || only.has(source);
  const connections = await listConnections(userId);
  const stripeConnection = connections.find((connection) => connection.toolkitSlug === "stripe" && connection.status === "active" && connection.connectedAccountId);
  const targets: MarketingAnalyticsTargets = {
    ga4: { connected: connected("google_analytics", connections), properties: [], error: null },
    searchConsole: { connected: connected("google_search_console", connections), sites: [], error: null },
    facebook: { connected: connected("facebook", connections), pages: [], error: null },
    instagram: { connected: connected("instagram", connections), accounts: [], error: null },
    stripe: {
      connected: Boolean(stripeConnection),
      account: stripeConnection?.connectedAccountId ? { ref: stripeConnection.connectedAccountId, name: "Connected Stripe account" } : null,
      error: null,
    },
    googleAds: { connected: connected("googleads", connections), accounts: [], error: null },
  };
  const operations: Promise<void>[] = [];

  if (targets.ga4.connected && shouldFetch("ga4")) operations.push((async () => {
    const result = await executeComposioTool(userId, "GOOGLE_ANALYTICS_LIST_ACCOUNT_SUMMARIES", { pageSize: 200 });
    try {
      const data = successfulData(result, "Google Analytics");
      const summaries = findArray(data, ["accountSummaries", "account_summaries"]);
      const properties: MarketingAnalyticsTarget[] = [];
      for (const summaryValue of summaries) {
        const summary = object(summaryValue);
        const propertySummaries = Array.isArray(summary.propertySummaries) ? summary.propertySummaries : Array.isArray(summary.property_summaries) ? summary.property_summaries : [];
        for (const propertyValue of propertySummaries) {
          const property = object(propertyValue);
          const resource = typeof property.property === "string" ? property.property : typeof property.name === "string" ? property.name : "";
          const id = resource.match(/(?:properties\/)?(\d{3,20})$/)?.[1];
          if (id) properties.push({ ref: id, name: typeof property.displayName === "string" ? property.displayName : `GA4 property ${id}` });
        }
      }
      targets.ga4.properties = [...new Map(properties.map((item) => [item.ref, item])).values()];
    } catch (error) { targets.ga4.error = error instanceof Error ? error.message : "Google Analytics properties could not be loaded."; }
  })());

  if (targets.searchConsole.connected && shouldFetch("search_console")) operations.push((async () => {
    const result = await executeComposioTool(userId, "GOOGLE_SEARCH_CONSOLE_LIST_SITES", {});
    try {
      const data = successfulData(result, "Search Console");
      const siteRows = findArray(data, ["siteEntry", "site_entry", "sites"]);
      const sites = siteRows.map((siteValue) => {
        const site = object(siteValue);
        const ref = typeof site.siteUrl === "string" ? site.siteUrl : typeof site.site_url === "string" ? site.site_url : "";
        return [ref, { ref, name: ref } as MarketingAnalyticsTarget] as const;
      }).filter(([ref]) => ref.length > 0);
      targets.searchConsole.sites = [...new Map(sites).values()];
    } catch (error) { targets.searchConsole.error = error instanceof Error ? error.message : "Search Console properties could not be loaded."; }
  })());

  if (targets.facebook.connected && shouldFetch("facebook_page")) operations.push((async () => {
    try {
      targets.facebook.pages = (await getMarketingPublishTargets(userId, "facebook"))
        .map((target) => ({ ref: target.id, name: target.name }));
    } catch (error) { targets.facebook.error = error instanceof Error ? error.message : "Facebook Pages could not be loaded."; }
  })());

  if (targets.instagram.connected && shouldFetch("instagram_account")) operations.push((async () => {
    try {
      targets.instagram.accounts = (await getMarketingPublishTargets(userId, "instagram"))
        .map((target) => ({ ref: target.id, name: target.name }));
    } catch (error) { targets.instagram.error = error instanceof Error ? error.message : "Instagram account could not be loaded."; }
  })());

  if (targets.googleAds.connected && shouldFetch("google_ads_campaign")) operations.push((async () => {
    try {
      const result = await cachedGoogleAdsAnalyticsAccounts(userId, (toolName, args) => executeComposioTool(userId, toolName, args));
      targets.googleAds.accounts = result.accounts;
      if (result.truncated) targets.googleAds.error = "Account discovery reached its safety limit. Some Google Ads accounts may be omitted.";
    } catch (error) { targets.googleAds.error = error instanceof Error ? error.message : "Google Ads accounts could not be loaded."; }
  })());

  await Promise.all(operations);
  return targets;
}

export async function listMarketingAnalyticsSnapshots(userId: string): Promise<MarketingAnalyticsSnapshot[]> {
  const result = await query(
    `SELECT id,provider,account_ref,account_name,range_start,range_end,metrics,fetched_at
       FROM sales_marketing_analytics_snapshots WHERE user_id=$1
      ORDER BY fetched_at DESC LIMIT 40`, [userId],
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    provider: row.provider as MarketingAnalyticsSnapshot["provider"],
    accountRef: row.account_ref as string,
    accountName: row.account_name as string,
    rangeStart: new Date(row.range_start).toISOString().slice(0, 10),
    rangeEnd: new Date(row.range_end).toISOString().slice(0, 10),
    metrics: object(row.metrics),
    fetchedAt: row.fetched_at as Date,
  }));
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeGoogleAdsCampaignMetrics(value: unknown): JsonObject {
  const data = unwrap(value);
  const rows = findArray(data, ["results", "rows", "campaigns", "items"]);
  const campaigns = rows.map((rowValue) => {
    const row = object(rowValue);
    const campaign = object(row.campaign);
    const metrics = object(row.metrics);
    const customer = object(row.customer);
    const pick = (source: JsonObject, camel: string, snake: string) => source[camel] ?? source[snake];
    return {
      id: String(pick(campaign, "id", "id") ?? ""),
      name: String(pick(campaign, "name", "name") ?? "Unnamed campaign"),
      status: String(pick(campaign, "status", "status") ?? "UNKNOWN"),
      impressions: numberValue(pick(metrics, "impressions", "impressions")),
      clicks: numberValue(pick(metrics, "clicks", "clicks")),
      costMicros: numberValue(pick(metrics, "costMicros", "cost_micros")),
      conversions: numberValue(pick(metrics, "conversions", "conversions")),
      conversionValue: numberValue(pick(metrics, "conversionsValue", "conversions_value")),
      currency: typeof pick(customer, "currencyCode", "currency_code") === "string"
        ? String(pick(customer, "currencyCode", "currency_code")).toUpperCase()
        : null,
    };
  });
  const selected = campaigns.slice(0, GOOGLE_ADS_MAX_CAMPAIGN_ROWS);
  const sum = (key: "impressions" | "clicks" | "costMicros" | "conversions" | "conversionValue") =>
    selected.reduce((total, campaign) => total + campaign[key], 0);
  const currencies = [...new Set(selected.map((campaign) => campaign.currency).filter((currency): currency is string => Boolean(currency)))];
  const first = selected[0];
  const truncated = rows.length > GOOGLE_ADS_MAX_CAMPAIGN_ROWS || data.truncated === true;
  return {
    currency: currencies.length === 1 ? currencies[0] : null,
    mixedCurrencies: currencies.length > 1,
    impressions: sum("impressions"),
    clicks: sum("clicks"),
    costMicros: sum("costMicros"),
    conversions: sum("conversions"),
    conversionValue: sum("conversionValue"),
    campaigns: selected.slice(0, 20).map(({ id, name, status, impressions, clicks, costMicros, conversions, conversionValue }) => ({
      id, name, status, impressions, clicks, costMicros, conversions, conversionValue,
    })),
    campaignRowsReturned: selected.length,
    rowCount: numberValue(data.rowCount ?? data.row_count ?? rows.length),
    truncated,
    note: "Google Ads reported campaign spend and conversion metrics in the selected account and date range. Conversion counts and values follow that account's configured Google Ads conversion actions; they are not Interlink CRM-attributed leads, cash collected, or proof of causal ROI.",
    truncationNote: truncated ? `Only the first ${GOOGLE_ADS_MAX_CAMPAIGN_ROWS} campaign rows are included; totals may be incomplete.` : null,
    ...(first?.currency ? { reportingCurrency: first.currency } : {}),
  };
}

export async function loadGoogleAdsCampaignMetrics(
  customerId: string,
  startDate: string,
  endDate: string,
  execute: MarketingComposioExecutor,
): Promise<JsonObject> {
  if (!/^\d{7,20}$/.test(customerId)) throw new AppError("Choose a valid Google Ads customer account.", 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new AppError("Choose valid dates for the Google Ads report.", 400);
  }
  const query = `SELECT customer.id, customer.currency_code, campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT ${GOOGLE_ADS_MAX_CAMPAIGN_ROWS + 1}`;
  const result = await execute("GOOGLEADS_SEARCH_STREAM_GAQL", { customer_id: customerId, query });
  return normalizeGoogleAdsCampaignMetrics(successfulData(result, "Google Ads"));
}

function ga4Metrics(value: unknown, aggregateValue?: unknown, landingPageValue?: unknown): JsonObject {
  const data = unwrap(value);
  const rows = findArray(data, ["rows"]);
  const aggregate = unwrap(aggregateValue);
  const aggregateRow = findArray(aggregate, ["rows", "totals"])[0];
  const aggregateMetrics = object(aggregateRow).metricValues ?? object(aggregateRow).metric_values;
  const totals = Array.isArray(aggregateMetrics) ? aggregateMetrics : [];
  const landingData = unwrap(landingPageValue);
  const landingRows = findArray(landingData, ["rows"]);
  const totalMetric = (index: number): number | null => {
    const raw = object(totals[index]).value;
    return raw === undefined || raw === null ? null : numberValue(raw);
  };
  const detailRows = rows.map((rowValue) => {
    const row = object(rowValue);
    const dimensions = Array.isArray(row.dimensionValues) ? row.dimensionValues : Array.isArray(row.dimension_values) ? row.dimension_values : [];
    const metrics = Array.isArray(row.metricValues) ? row.metricValues : Array.isArray(row.metric_values) ? row.metric_values : [];
    const metric = (index: number) => numberValue(object(metrics[index]).value);
    const dimension = (index: number, fallback: string) => typeof object(dimensions[index]).value === "string" ? object(dimensions[index]).value as string : fallback;
    return {
      channel: dimension(0, "Unclassified"), sourceMedium: dimension(1, "(not set)"), campaign: dimension(2, "(not set)"),
      sessions: metric(0), users: metric(1), keyEvents: metric(2),
    };
  });
  const channelTotals = new Map<string, { channel: string; sessions: number; keyEvents: number }>();
  for (const row of detailRows) {
    const totals = channelTotals.get(row.channel) ?? { channel: row.channel, sessions: 0, keyEvents: 0 };
    totals.sessions += row.sessions;
    totals.keyEvents += row.keyEvents;
    channelTotals.set(row.channel, totals);
  }
  const channels = [...channelTotals.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 20);
  const campaigns = detailRows
    .filter((row) => row.campaign !== "(not set)")
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 20)
    .map(({ channel, sourceMedium, campaign, sessions, keyEvents }) => ({ channel, sourceMedium, campaign, sessions, keyEvents }));
  const landingPages = landingRows.map((rowValue) => {
    const row = object(rowValue);
    const dimensions = Array.isArray(row.dimensionValues) ? row.dimensionValues : Array.isArray(row.dimension_values) ? row.dimension_values : [];
    const metrics = Array.isArray(row.metricValues) ? row.metricValues : Array.isArray(row.metric_values) ? row.metric_values : [];
    const path = object(dimensions[0]).value;
    return {
      path: typeof path === "string" && path.trim() ? path : "(not set)",
      sessions: numberValue(object(metrics[0]).value),
      keyEvents: numberValue(object(metrics[1]).value),
      revenue: numberValue(object(metrics[2]).value),
    };
  });
  landingPages.sort((a, b) => b.sessions - a.sessions);
  const landingPageRowCount = numberValue(landingData.rowCount ?? landingData.row_count ?? landingRows.length);
  return {
    sessions: totalMetric(0) ?? detailRows.reduce((sum, item) => sum + item.sessions, 0),
    users: totalMetric(1),
    keyEvents: totalMetric(2) ?? detailRows.reduce((sum, item) => sum + item.keyEvents, 0),
    totalRevenue: totalMetric(3),
    revenueCurrency: typeof aggregate.currencyCode === "string" ? aggregate.currencyCode
      : typeof landingData.currencyCode === "string" ? landingData.currencyCode : null,
    channelUsersAreNonAdditive: true,
    channels,
    campaigns,
    landingPages,
    landingPageRowCount,
    landingPagesTruncated: landingPageRowCount > landingRows.length,
    landingPageRevenueCurrency: typeof landingData.currencyCode === "string" ? landingData.currencyCode : null,
    rowCount: numberValue(data.rowCount ?? data.row_count ?? rows.length),
    breakdownTruncated: numberValue(data.rowCount ?? data.row_count ?? rows.length) > rows.length,
    reportingCurrency: typeof data.currencyCode === "string" ? data.currencyCode : null,
  };
}

function searchConsoleDimensionRows(value: unknown, dimension: "query" | "page"): { rows: JsonObject[]; rowLimitReached: boolean } {
  const data = unwrap(value);
  const sourceRows = findArray(data, ["rows"]);
  const rows = sourceRows.flatMap((rowValue) => {
    const row = object(rowValue);
    const keys = Array.isArray(row.keys) ? row.keys : [];
    const rawValue = keys[0];
    if (typeof rawValue !== "string" || !rawValue.trim()) return [];
    let label = rawValue.trim();
    if (dimension === "page") {
      try { label = new URL(label).pathname || "/"; }
      catch { label = label.split(/[?#]/, 1)[0] || "/"; }
    }
    return [{
      [dimension]: label.slice(0, 500),
      clicks: numberValue(row.clicks),
      impressions: numberValue(row.impressions),
      ctr: numberValue(row.ctr),
      position: numberValue(row.position),
    }];
  }).sort((a, b) => Number(b.clicks) - Number(a.clicks));
  return { rows: rows.slice(0, SEARCH_CONSOLE_DISPLAY_ROW_LIMIT), rowLimitReached: sourceRows.length >= SEARCH_CONSOLE_DIMENSION_ROW_LIMIT };
}

function searchConsoleMetrics(value: unknown, queryValue?: unknown, pageValue?: unknown): JsonObject {
  const data = unwrap(value);
  const rows = findArray(data, ["rows"]);
  const days = rows.map((rowValue) => {
    const row = object(rowValue);
    const keys = Array.isArray(row.keys) ? row.keys : [];
    return {
      date: typeof keys[0] === "string" ? keys[0] : "",
      clicks: numberValue(row.clicks),
      impressions: numberValue(row.impressions),
      ctr: numberValue(row.ctr),
      position: numberValue(row.position),
    };
  });
  const clicks = days.reduce((sum, item) => sum + item.clicks, 0);
  const impressions = days.reduce((sum, item) => sum + item.impressions, 0);
  const weightedPosition = days.reduce((sum, item) => sum + item.position * item.impressions, 0);
  const queryReport = queryValue === undefined ? null : searchConsoleDimensionRows(queryValue, "query");
  const pageReport = pageValue === undefined ? null : searchConsoleDimensionRows(pageValue, "page");
  return {
    clicks, impressions, ctr: impressions ? clicks / impressions : 0,
    averagePosition: impressions ? weightedPosition / impressions : 0,
    days, rowCount: numberValue(data.rowCount ?? data.row_count ?? days.length),
    topQueries: queryReport?.rows ?? [], topQueriesUnavailable: queryValue === undefined,
    topQueriesLimitReached: queryReport?.rowLimitReached ?? false,
    topPages: pageReport?.rows ?? [], topPagesUnavailable: pageValue === undefined,
    topPagesLimitReached: pageReport?.rowLimitReached ?? false,
    dimensionReportNote: "Search Console may omit low-volume queries for privacy and can limit detailed rows. Query phrases are provider data and should be treated as potentially sensitive. Page URLs are stored as paths without query strings.",
    dataState: "final", freshnessNote: "Search Console final data can lag by several days.",
  };
}

export function normalizeMarketingSocialInsights(value: unknown): JsonObject {
  const data = unwrap(value);
  const rows = findArray(data, ["data", "metrics"]);
  const metrics = rows.flatMap((entry) => {
    const row = object(entry);
    const name = typeof row.name === "string" ? row.name : typeof row.title === "string" ? row.title : null;
    if (!name) return [];
    const rawValues = Array.isArray(row.values) ? row.values : row.total_value !== undefined ? [row.total_value] : [];
    const points = rawValues.map((pointValue) => {
      const point = object(pointValue);
      return {
        date: typeof point.end_time === "string" ? point.end_time.slice(0, 10) : null,
        value: point.value ?? pointValue,
      };
    });
    const totals: Record<string, number> = {};
    for (const point of points) {
      if (typeof point.value === "number" && Number.isFinite(point.value)) totals.total = (totals.total ?? 0) + point.value;
      else if (typeof point.value === "string" && Number.isFinite(Number(point.value))) totals.total = (totals.total ?? 0) + Number(point.value);
      else if (point.value && typeof point.value === "object" && !Array.isArray(point.value)) {
        for (const [key, raw] of Object.entries(point.value as Record<string, unknown>)) {
          const amount = typeof raw === "number" ? raw : Number(raw);
          if (Number.isFinite(amount)) totals[key] = (totals[key] ?? 0) + amount;
        }
      }
    }
    return [{ name, points, totals }];
  });
  return {
    metrics,
    note: "Daily reach values can include repeat viewers across days. These provider aggregates are separate from CRM attribution and sales outcomes.",
  };
}

const STRIPE_PAYMENT_TYPES = new Set(["charge", "payment"]);
const STRIPE_REFUND_TYPES = new Set(["refund", "payment_refund"]);
const STRIPE_PAYMENT_REVERSAL_TYPES = new Set(["payment_failure_refund", "payment_reversal"]);

export function normalizeStripeBalanceTransactions(transactions: unknown[], truncated: boolean, pagesFetched: number): JsonObject {
  const byCurrency = new Map<string, {
    currency: string; grossPaymentsMinor: number; refundsMinor: number; feesMinor: number;
    paymentReversalMinor: number; refundsReturnedMinor: number; netAfterFeesMinor: number;
    paymentCount: number; refundCount: number; paymentReversalCount: number; refundReturnCount: number;
    pendingNetMinor: number; availableNetMinor: number;
  }>();
  let includedTransactions = 0;

  for (const transactionValue of transactions) {
    const transaction = object(transactionValue);
    const type = typeof transaction.type === "string" ? transaction.type : "";
    if (!STRIPE_PAYMENT_TYPES.has(type) && !STRIPE_REFUND_TYPES.has(type)
      && !STRIPE_PAYMENT_REVERSAL_TYPES.has(type) && type !== "refund_failure") continue;
    const currencyValue = typeof transaction.currency === "string" ? transaction.currency.toUpperCase() : "";
    const amount = transaction.amount;
    if (!/^[A-Z]{3}$/.test(currencyValue) || typeof amount !== "number" || !Number.isSafeInteger(amount)) continue;

    const feeValue = transaction.fee;
    const fee = typeof feeValue === "number" && Number.isSafeInteger(feeValue) ? feeValue : 0;
    const netValue = transaction.net;
    const net = typeof netValue === "number" && Number.isSafeInteger(netValue) ? netValue : amount - fee;
    const totals = byCurrency.get(currencyValue) ?? {
      currency: currencyValue, grossPaymentsMinor: 0, refundsMinor: 0, feesMinor: 0,
      paymentReversalMinor: 0, refundsReturnedMinor: 0, netAfterFeesMinor: 0,
      paymentCount: 0, refundCount: 0, paymentReversalCount: 0, refundReturnCount: 0,
      pendingNetMinor: 0, availableNetMinor: 0,
    };
    includedTransactions += 1;
    totals.feesMinor += fee;
    totals.netAfterFeesMinor += net;
    if (type === "charge" || type === "payment") {
      totals.grossPaymentsMinor += Math.max(0, amount);
      totals.paymentCount += 1;
    } else if (type === "refund" || type === "payment_refund") {
      if (amount < 0) {
        totals.refundsMinor += Math.abs(amount);
        totals.refundCount += 1;
      } else if (amount > 0) {
        totals.refundsReturnedMinor += amount;
        totals.refundReturnCount += 1;
      }
    } else if (STRIPE_PAYMENT_REVERSAL_TYPES.has(type)) {
      totals.paymentReversalMinor += Math.abs(amount);
      totals.paymentReversalCount += 1;
    } else if (type === "refund_failure") {
      totals.refundsReturnedMinor += Math.max(0, amount);
      totals.refundReturnCount += 1;
    }
    if (transaction.status === "pending") totals.pendingNetMinor += net;
    if (transaction.status === "available") totals.availableNetMinor += net;
    byCurrency.set(currencyValue, totals);
  }

  return {
    currencies: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    includedTransactions,
    pagesFetched,
    truncated,
    note: "Shows Stripe charge/payment and refund balance transactions created in this range. Payment failure/reversal transactions and funds returned after failed refunds are reported separately from customer refunds. Other balance transaction types (including payouts, transfers, disputes, and adjustments) are excluded. These are account-level payment-flow totals, not campaign or lead attribution, bank deposits, recognized revenue, or ROI. Pending and available reflect each transaction's Stripe balance status when fetched.",
    truncationNote: truncated ? "More than 1,000 matching transactions were available; totals cover only the most recent 1,000 and are incomplete for this range." : null,
  };
}

const STRIPE_BALANCE_TRANSACTION_PAGE_SIZE = 100;
const STRIPE_BALANCE_TRANSACTION_MAX_PAGES = 10;

type StripeBalancePageExecutor = (args: Record<string, unknown>) => Promise<{ ok: boolean; message: string; data?: unknown }>;

export async function loadStripeBalanceMetrics(startDate: string, endDate: string, executePage: StripeBalancePageExecutor): Promise<JsonObject> {
  const created = {
    gte: Math.floor(Date.parse(`${startDate}T00:00:00.000Z`) / 1000),
    lte: Math.floor(Date.parse(`${endDate}T23:59:59.999Z`) / 1000),
  };
  const transactions: unknown[] = [];
  let startingAfter: string | undefined;
  let hasMore = true;
  let pagesFetched = 0;

  while (hasMore && pagesFetched < STRIPE_BALANCE_TRANSACTION_MAX_PAGES) {
    const result = await executePage({
      created,
      limit: STRIPE_BALANCE_TRANSACTION_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = successfulData(result, "Stripe");
    const page = findArray(data, ["data", "transactions", "balance_transactions", "balanceTransactions", "results", "items"]);
    transactions.push(...page);
    pagesFetched += 1;
    hasMore = data.has_more === true || data.hasMore === true;
    if (hasMore) {
      const lastId = object(page[page.length - 1]).id;
      if (typeof lastId !== "string" || !lastId || lastId === startingAfter) {
        throw new AppError("Stripe returned another page without a usable pagination cursor.", 502);
      }
      startingAfter = lastId;
    }
  }

  return normalizeStripeBalanceTransactions(transactions, hasMore, pagesFetched);
}

async function loadStripeBalanceTransactions(userId: string, startDate: string, endDate: string): Promise<JsonObject> {
  return loadStripeBalanceMetrics(startDate, endDate, (args) =>
    executeComposioTool(userId, "STRIPE_LIST_BALANCE_TRANSACTIONS", args),
  );
}

async function saveSnapshot(userId: string, snapshot: {
  provider: MarketingAnalyticsSnapshot["provider"]; accountRef: string; accountName: string;
  rangeStart: string; rangeEnd: string; metrics: JsonObject;
}): Promise<void> {
  await query(
    `INSERT INTO sales_marketing_analytics_snapshots
       (user_id,provider,account_ref,account_name,range_start,range_end,metrics,fetched_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now(),now())
     ON CONFLICT(user_id,provider,account_ref,range_start,range_end)
     DO UPDATE SET account_name=EXCLUDED.account_name,metrics=EXCLUDED.metrics,fetched_at=now(),updated_at=now()`,
    [userId, snapshot.provider, snapshot.accountRef, snapshot.accountName, snapshot.rangeStart, snapshot.rangeEnd, JSON.stringify(snapshot.metrics)],
  );
}

export async function refreshMarketingAnalytics(userId: string, input: {
  ga4PropertyId?: string; searchConsoleSite?: string; facebookPageId?: string; instagramUserId?: string;
  stripeBalance?: boolean; googleAdsCustomerId?: string;
  startDate: string; endDate: string;
}): Promise<{ refreshed: string[]; failures: { provider: string; message: string }[] }> {
  const requested = new Set<MarketingAnalyticsSource>();
  if (input.ga4PropertyId) requested.add("ga4");
  if (input.searchConsoleSite) requested.add("search_console");
  if (input.facebookPageId) requested.add("facebook_page");
  if (input.instagramUserId) requested.add("instagram_account");
  if (input.stripeBalance) requested.add("stripe_balance");
  if (input.googleAdsCustomerId) requested.add("google_ads_campaign");
  const targets = await getMarketingAnalyticsTargets(userId, requested);
  const work: Array<Promise<void>> = [];
  const refreshed: string[] = [];
  const failures: { provider: string; message: string }[] = [];

  if (input.ga4PropertyId) {
    const target = targets.ga4.properties.find((item) => item.ref === input.ga4PropertyId);
    if (!target) throw new AppError("Choose a Google Analytics property available to this connected account.", 400);
    work.push((async () => {
      try {
        const [channelResult, aggregateResult, landingPageResult] = await Promise.allSettled([
          executeComposioTool(userId, "GOOGLE_ANALYTICS_RUN_REPORT", {
          property: `properties/${target.ref}`,
          dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
          dimensions: [{ name: "sessionDefaultChannelGroup" }, { name: "sessionSourceMedium" }, { name: "sessionCampaignName" }],
          metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "keyEvents" }],
          limit: 1000,
          returnPropertyQuota: false,
          }),
          executeComposioTool(userId, "GOOGLE_ANALYTICS_RUN_REPORT", {
            property: `properties/${target.ref}`,
            dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
            metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "keyEvents" }, { name: "totalRevenue" }],
            returnPropertyQuota: false,
          }),
          executeComposioTool(userId, "GOOGLE_ANALYTICS_RUN_REPORT", {
            property: `properties/${target.ref}`,
            dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
            dimensions: [{ name: "landingPage" }],
            metrics: [{ name: "sessions" }, { name: "keyEvents" }, { name: "totalRevenue" }],
            orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
            limit: 100,
            returnPropertyQuota: false,
          }),
        ]);
        if (channelResult.status === "rejected") throw channelResult.reason;
        if (aggregateResult.status === "rejected") throw aggregateResult.reason;
        const channelData = successfulData(channelResult.value, "Google Analytics");
        const aggregateData = successfulData(aggregateResult.value, "Google Analytics");
        let landingPageData: JsonObject = {};
        let landingPagesReportUnavailable = landingPageResult.status === "rejected";
        if (landingPageResult.status === "fulfilled") {
          try { landingPageData = successfulData(landingPageResult.value, "Google Analytics"); }
          catch { landingPagesReportUnavailable = true; }
        }
        const metrics = ga4Metrics(channelData, aggregateData, landingPageData);
        metrics.landingPagesReportUnavailable = landingPagesReportUnavailable;
        await saveSnapshot(userId, { provider: "ga4", accountRef: target.ref, accountName: target.name, rangeStart: input.startDate, rangeEnd: input.endDate, metrics });
        refreshed.push("ga4");
      } catch (error) { failures.push({ provider: "ga4", message: error instanceof Error ? error.message : "Google Analytics data could not be loaded." }); }
    })());
  }

  if (input.searchConsoleSite) {
    const target = targets.searchConsole.sites.find((item) => item.ref === input.searchConsoleSite);
    if (!target) throw new AppError("Choose a Search Console property available to this connected account.", 400);
    work.push((async () => {
      try {
        const runSearchAnalytics = (dimension: "date" | "query" | "page") => executeComposioTool(userId, "GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY", {
          site_url: target.ref, start_date: input.startDate, end_date: input.endDate,
          dimensions: [dimension], search_type: "web",
          row_limit: dimension === "date" ? 1000 : SEARCH_CONSOLE_DIMENSION_ROW_LIMIT,
          start_row: 0, data_state: "final",
        });
        const [dailyResult, queryResult, pageResult] = await Promise.allSettled([
          runSearchAnalytics("date"), runSearchAnalytics("query"), runSearchAnalytics("page"),
        ]);
        if (dailyResult.status === "rejected") throw dailyResult.reason;
        const dailyData = successfulData(dailyResult.value, "Search Console");
        let queryData: JsonObject | undefined;
        let pageData: JsonObject | undefined;
        if (queryResult.status === "fulfilled") {
          try { queryData = successfulData(queryResult.value, "Search Console query report"); } catch { /* keep daily report available */ }
        }
        if (pageResult.status === "fulfilled") {
          try { pageData = successfulData(pageResult.value, "Search Console page report"); } catch { /* keep daily report available */ }
        }
        const metrics = searchConsoleMetrics(dailyData, queryData, pageData);
        await saveSnapshot(userId, { provider: "search_console", accountRef: target.ref, accountName: target.name, rangeStart: input.startDate, rangeEnd: input.endDate, metrics });
        refreshed.push("search_console");
      } catch (error) { failures.push({ provider: "search_console", message: error instanceof Error ? error.message : "Search Console data could not be loaded." }); }
    })());
  }

  if (input.facebookPageId) {
    const target = targets.facebook.pages.find((item) => item.ref === input.facebookPageId);
    if (!target) throw new AppError("Choose a Facebook Page available to this connected account.", 400);
    work.push((async () => {
      try {
        const result = await executeComposioTool(userId, "FACEBOOK_GET_PAGE_INSIGHTS", {
          page_id: target.ref, since: input.startDate, until: input.endDate, period: "day",
          metrics: "page_daily_follows_unique,page_daily_unfollows_unique,page_media_view,page_post_engagements,page_video_views,page_total_actions",
        });
        const metrics = normalizeMarketingSocialInsights(successfulData(result, "Facebook Pages"));
        await saveSnapshot(userId, { provider: "facebook_page", accountRef: target.ref, accountName: target.name, rangeStart: input.startDate, rangeEnd: input.endDate, metrics });
        refreshed.push("facebook_page");
      } catch (error) { failures.push({ provider: "facebook_page", message: error instanceof Error ? error.message : "Facebook Page insights could not be loaded." }); }
    })());
  }

  if (input.instagramUserId) {
    const target = targets.instagram.accounts.find((item) => item.ref === input.instagramUserId);
    if (!target) throw new AppError("Choose an Instagram account available to this connected account.", 400);
    work.push((async () => {
      try {
        const result = await executeComposioTool(userId, "INSTAGRAM_GET_USER_INSIGHTS", {
          ig_user_id: target.ref, since: input.startDate, until: input.endDate, period: "day", metric_type: "time_series",
          metric: ["reach", "accounts_engaged", "total_interactions", "views", "profile_views", "website_clicks"],
        });
        const metrics = normalizeMarketingSocialInsights(successfulData(result, "Instagram"));
        await saveSnapshot(userId, { provider: "instagram_account", accountRef: target.ref, accountName: target.name, rangeStart: input.startDate, rangeEnd: input.endDate, metrics });
        refreshed.push("instagram_account");
      } catch (error) { failures.push({ provider: "instagram_account", message: error instanceof Error ? error.message : "Instagram insights could not be loaded." }); }
    })());
  }

  if (input.stripeBalance) {
    const target = targets.stripe.account;
    if (!targets.stripe.connected || !target) throw new AppError("Connect Stripe before refreshing account balance activity.", 400);
    work.push((async () => {
      try {
        const metrics = await loadStripeBalanceTransactions(userId, input.startDate, input.endDate);
        await saveSnapshot(userId, {
          provider: "stripe_balance", accountRef: target.ref, accountName: target.name,
          rangeStart: input.startDate, rangeEnd: input.endDate, metrics,
        });
        refreshed.push("stripe_balance");
      } catch (error) {
        failures.push({ provider: "stripe_balance", message: error instanceof Error ? error.message : "Stripe balance activity could not be loaded." });
      }
    })());
  }

  if (input.googleAdsCustomerId) {
    const target = targets.googleAds.accounts.find((item) => item.ref === input.googleAdsCustomerId);
    if (!target) throw new AppError("Choose a Google Ads customer account available to this connected account.", 400);
    work.push((async () => {
      try {
        const metrics = await loadGoogleAdsCampaignMetrics(target.ref, input.startDate, input.endDate,
          (toolName, args) => executeComposioTool(userId, toolName, args));
        await saveSnapshot(userId, {
          provider: "google_ads_campaign", accountRef: target.ref, accountName: target.name,
          rangeStart: input.startDate, rangeEnd: input.endDate, metrics,
        });
        refreshed.push("google_ads_campaign");
      } catch (error) {
        failures.push({ provider: "google_ads_campaign", message: error instanceof Error ? error.message : "Google Ads campaign performance could not be loaded." });
      }
    })());
  }

  await Promise.all(work);
  return { refreshed, failures };
}

export { ga4Metrics as normalizeGa4Analytics, searchConsoleMetrics as normalizeSearchConsoleAnalytics };
