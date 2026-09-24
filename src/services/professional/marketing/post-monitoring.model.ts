export type MarketingPostProvider = "facebook" | "instagram" | "linkedin";
export type MarketingPostProviderState = "live" | "not_published";
export type MarketingPostMetricName = "likes" | "comments" | "shares" | "views" | "reach" | "saves" | "reposts" | "interactions";
export type MarketingPostMetrics = Partial<Record<MarketingPostMetricName, number>>;

export interface NormalizedMarketingPostCheck {
  providerState: MarketingPostProviderState;
  providerUrl: string | null;
  providerPublishedAt: Date | null;
  metrics: MarketingPostMetrics;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function unwrap(value: unknown): JsonObject {
  let current = object(value);
  for (let depth = 0; depth < 5; depth += 1) {
    const next = current.data ?? current.response_data ?? current.responseData ?? current.result;
    if (!next || typeof next !== "object" || Array.isArray(next)) break;
    current = object(next);
  }
  return current;
}

function count(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = object(value);
    for (const key of ["total_count", "count", "value"]) {
      const parsed = count(row[key]);
      if (parsed !== undefined) return parsed;
    }
    const summary = count(row.summary);
    if (summary !== undefined) return summary;
  }
  return undefined;
}

function firstCount(row: JsonObject, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = count(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseProviderDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

function compactMetrics(entries: Array<[keyof MarketingPostMetrics, number | undefined]>): MarketingPostMetrics {
  const result: MarketingPostMetrics = {};
  for (const [key, value] of entries) if (value !== undefined) result[key] = value;
  return result;
}

function metricRows(value: unknown): JsonObject[] {
  const root = unwrap(value);
  const source = Array.isArray(root.data) ? root.data : Array.isArray(root.metrics) ? root.metrics : [];
  return source.map(object);
}

function insightCount(value: unknown, ...names: string[]): number | undefined {
  const row = metricRows(value).find((item) => typeof item.name === "string" && names.includes(item.name));
  if (!row) return undefined;
  const firstValue = Array.isArray(row.values) ? object(row.values[0]).value : undefined;
  return count(firstValue ?? row.value ?? row.total_value);
}

export function normalizeMarketingPostCheck(
  provider: MarketingPostProvider,
  detailsValue: unknown,
  insightsValue?: unknown,
): NormalizedMarketingPostCheck {
  const details = unwrap(detailsValue);
  const createdAt = parseProviderDate(details.created_time ?? details.timestamp ?? details.createdAt);
  const providerUrl = parseHttpsUrl(details.permalink_url ?? details.permalink ?? details.url);

  if (provider === "facebook") {
    const state: MarketingPostProviderState = details.is_published === false ? "not_published" : "live";
    return {
      providerState: state,
      providerUrl,
      providerPublishedAt: createdAt,
      metrics: compactMetrics([
        ["likes", firstCount(details, "likes")],
        ["comments", firstCount(details, "comments")],
        ["shares", firstCount(details, "shares")],
        ["views", insightCount(insightsValue, "post_media_view")],
        ["reach", insightCount(insightsValue, "post_total_media_view_unique")],
      ]),
    };
  }

  if (provider === "instagram") {
    return {
      providerState: "live",
      providerUrl,
      providerPublishedAt: createdAt,
      metrics: compactMetrics([
        ["likes", firstCount(details, "like_count", "total_like_count")],
        ["comments", firstCount(details, "comments_count", "total_comments_count")],
        ["shares", firstCount(details, "shares_count")],
        ["views", firstCount(details, "view_count", "total_views_count")],
        ["saves", firstCount(details, "saved_count")],
        ["reposts", firstCount(details, "reposts_count")],
      ]),
    };
  }

  return {
    providerState: "live",
    providerUrl,
    providerPublishedAt: createdAt,
    // LinkedIn's current share-statistics action is organization-scoped. Member-profile
    // read-back confirms the post itself; report no engagement counters when unavailable.
    metrics: {},
  };
}

export function assertMarketingPostOwnedByTarget(
  provider: MarketingPostProvider,
  targetId: string,
  providerPostId: string,
  detailsValue: unknown,
): boolean {
  if (provider === "facebook") {
    const postPageId = providerPostId.match(/^(\d{5,30})_\d{1,40}$/)?.[1];
    if (postPageId && /^\d{5,30}$/.test(targetId) && postPageId !== targetId) return false;
  }
  const details = unwrap(detailsValue);
  const owner = object(details.owner);
  const ownerId = owner.id;
  const candidate = provider === "instagram"
    ? (typeof ownerId === "string" ? ownerId : typeof ownerId === "number" && Number.isSafeInteger(ownerId) ? String(ownerId) : null)
    : provider === "linkedin"
      ? (typeof details.author === "string" ? details.author : typeof details.actor === "string" ? details.actor : null)
      : null;
  return !candidate || candidate === targetId;
}
