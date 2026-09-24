import { query, withTransaction } from "../../../config/db";
import { AppError } from "../../../utils/errors";
import { executeComposioTool } from "../../composio/composio.service";
import { getMarketingContentItem, type MarketingContentItem } from "./content.service";
import {
  assertMarketingPostOwnedByTarget,
  normalizeMarketingPostCheck,
  type MarketingPostProvider,
  type MarketingPostProviderState,
  type MarketingPostMetrics,
} from "./post-monitoring.model";

export interface MarketingPostMetricsSnapshot {
  id: string;
  contentItemId: string;
  provider: MarketingPostProvider;
  providerPostId: string;
  providerState: MarketingPostProviderState;
  providerUrl: string | null;
  providerPublishedAt: Date | null;
  metrics: MarketingPostMetrics;
  checkedAt: Date;
}

function mapSnapshot(row: Record<string, unknown>): MarketingPostMetricsSnapshot {
  const provider = String(row.provider);
  if (!(provider === "facebook" || provider === "instagram" || provider === "linkedin")) {
    throw new AppError("A saved provider check has an unsupported provider.", 500);
  }
  const providerState = String(row.provider_state);
  if (!(providerState === "live" || providerState === "not_published")) {
    throw new AppError("A saved provider check has an unsupported status.", 500);
  }
  const metrics = row.metrics && typeof row.metrics === "object" && !Array.isArray(row.metrics)
    ? row.metrics as MarketingPostMetrics
    : {};
  return {
    id: String(row.id),
    contentItemId: String(row.content_item_id),
    provider,
    providerPostId: String(row.provider_post_id),
    providerState,
    providerUrl: typeof row.provider_url === "string" ? row.provider_url : null,
    providerPublishedAt: row.provider_published_at as Date | null,
    metrics,
    checkedAt: row.checked_at as Date,
  };
}

async function execute(userId: string, slug: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await executeComposioTool(userId, slug, args);
  if (!result.ok) throw new AppError(result.message || slug + " failed.", 502);
  return result.data;
}

type LinkedPost = MarketingContentItem & {
  provider: MarketingPostProvider;
  providerItemId: string;
  providerTargetId: string;
};

function assertDirectlyLinkedPublishedPost(item: MarketingContentItem): asserts item is LinkedPost {
  if (item.status !== "published") throw new AppError("Only a published post can be checked with its provider.", 409);
  if (!(item.provider === "facebook" || item.provider === "instagram" || item.provider === "linkedin")) {
    throw new AppError("Provider read-back is available for directly published Facebook, Instagram, and LinkedIn posts.", 409);
  }
  if (!item.providerItemId || !item.providerTargetId) {
    throw new AppError("This calendar entry has no saved provider post and destination IDs. It can still be reviewed manually.", 409);
  }
  if (item.provider === "facebook" && !/^\d{5,30}_\d{1,40}$/.test(item.providerItemId)) {
    throw new AppError("The saved Facebook post ID is not a Page-scoped post ID and cannot be checked safely.", 409);
  }
  if (item.provider === "instagram" && !/^\d{5,30}$/.test(item.providerItemId)) {
    throw new AppError("The saved Instagram media ID is not numeric and cannot be checked safely.", 409);
  }
  if (item.provider === "linkedin" && !/^urn:li:(?:share|ugcPost):[A-Za-z0-9_-]+$/.test(item.providerItemId)) {
    throw new AppError("The saved LinkedIn post ID is not a supported post URN and cannot be checked safely.", 409);
  }
}

async function readPublishedPost(userId: string, item: LinkedPost): Promise<{ details: unknown; insights?: unknown }> {
  if (item.provider === "facebook") {
    const details = await execute(userId, "FACEBOOK_GET_POST", {
      post_id: item.providerItemId,
      fields: "id,is_published,created_time,permalink_url,likes.summary(true),comments.summary(true),shares",
    });
    let insights: unknown;
    try {
      insights = await execute(userId, "FACEBOOK_GET_POST_INSIGHTS", {
        post_id: item.providerItemId,
        metrics: "post_media_view,post_total_media_view_unique",
        period: "lifetime",
      });
    } catch {
      // Basic post state and engagement counts remain useful without the insights permission.
    }
    return { details, insights };
  }
  if (item.provider === "instagram") {
    const details = await execute(userId, "INSTAGRAM_GET_IG_MEDIA", {
      ig_media_id: item.providerItemId,
      fields: "id,owner,media_type,permalink,timestamp,like_count,comments_count,view_count,shares_count,saved_count,reposts_count,total_like_count,total_comments_count,total_views_count",
    });
    return { details };
  }
  const details = await execute(userId, "LINKEDIN_GET_POST_CONTENT", { post_id: item.providerItemId });
  return { details };
}

export async function listLatestMarketingPostMetrics(userId: string): Promise<MarketingPostMetricsSnapshot[]> {
  const result = await query(
    "SELECT DISTINCT ON (s.content_item_id) " +
      "s.id,s.content_item_id,s.provider,s.provider_post_id,s.provider_state,s.provider_url," +
      "s.provider_published_at,s.metrics,s.checked_at " +
      "FROM sales_marketing_post_metrics_snapshots s " +
      "JOIN sales_marketing_content_items c ON c.id=s.content_item_id AND c.user_id=s.user_id " +
      "WHERE s.user_id=$1 AND c.status='published' " +
      "ORDER BY s.content_item_id,s.checked_at DESC,s.id DESC LIMIT 250",
    [userId],
  );
  return result.rows.map((row) => mapSnapshot(row as Record<string, unknown>));
}

export async function listMarketingPostMetricsHistory(userId: string, contentId: string): Promise<MarketingPostMetricsSnapshot[]> {
  const result = await query(
    "SELECT id,content_item_id,provider,provider_post_id,provider_state,provider_url," +
      "provider_published_at,metrics,checked_at FROM sales_marketing_post_metrics_snapshots " +
      "WHERE user_id=$1 AND content_item_id=$2 ORDER BY checked_at DESC,id DESC LIMIT 40",
    [userId, contentId],
  );
  return result.rows.map((row) => mapSnapshot(row as Record<string, unknown>));
}

export async function checkMarketingPublishedPost(userId: string, contentId: string): Promise<MarketingPostMetricsSnapshot> {
  const item = await getMarketingContentItem(userId, contentId);
  assertDirectlyLinkedPublishedPost(item);
  const response = await readPublishedPost(userId, item);
  if (!assertMarketingPostOwnedByTarget(item.provider, item.providerTargetId, item.providerItemId, response.details)) {
    throw new AppError("The connected provider returned a post owned by a different destination. No snapshot was saved.", 409);
  }
  const normalized = normalizeMarketingPostCheck(item.provider, response.details, response.insights);

  return withTransaction(async (client) => {
    const current = await client.query(
      "SELECT status,provider,provider_item_id,provider_target_id " +
        "FROM sales_marketing_content_items WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [contentId, userId],
    );
    const row = current.rows[0] as Record<string, unknown> | undefined;
    if (!row || row.status !== "published" || row.provider !== item.provider
      || row.provider_item_id !== item.providerItemId || row.provider_target_id !== item.providerTargetId) {
      throw new AppError("This provider post changed while it was being checked. Refresh the calendar and try again.", 409);
    }

    const inserted = await client.query(
      "INSERT INTO sales_marketing_post_metrics_snapshots " +
        "(user_id,content_item_id,provider,provider_post_id,provider_state,provider_url,provider_published_at,metrics) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) " +
        "RETURNING id,content_item_id,provider,provider_post_id,provider_state,provider_url," +
        "provider_published_at,metrics,checked_at",
      [userId, contentId, item.provider, item.providerItemId, normalized.providerState,
        normalized.providerUrl, normalized.providerPublishedAt, JSON.stringify(normalized.metrics)],
    );
    await client.query(
      "DELETE FROM sales_marketing_post_metrics_snapshots " +
        "WHERE user_id=$1 AND content_item_id=$2 AND id NOT IN (" +
        "SELECT id FROM sales_marketing_post_metrics_snapshots " +
        "WHERE user_id=$1 AND content_item_id=$2 ORDER BY checked_at DESC,id DESC LIMIT 40)",
      [userId, contentId],
    );
    await client.query(
      "INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note) " +
        "VALUES($1,'content',$2,'provider_checked',$3)",
      [userId, contentId, "Read-only provider check via " + item.provider + ": " + normalized.providerState +
        "; " + Object.keys(normalized.metrics).length + " metric fields available."],
    );
    return mapSnapshot(inserted.rows[0] as Record<string, unknown>);
  });
}

export async function getMarketingPostMetricsHistory(userId: string, contentId: string): Promise<MarketingPostMetricsSnapshot[]> {
  await getMarketingContentItem(userId, contentId);
  return listMarketingPostMetricsHistory(userId, contentId);
}
