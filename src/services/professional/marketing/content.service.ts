import { query, withTransaction } from "../../../config/db";
import type { PoolClient } from "pg";
import { AppError, NotFoundError } from "../../../utils/errors";
import { z } from "zod";
import { geminiGenerateContent, isGeminiLive } from "../../ai/geminiClient";
import { shouldResetMarketingContentApproval, type MarketingContentStatus } from "./content-state";

export type MarketingChannel = "email" | "instagram" | "facebook" | "linkedin" | "youtube" | "blog" | "landing_page" | "search" | "ad" | "influencer" | "event" | "other";
export type { MarketingContentStatus } from "./content-state";

export interface MarketingContentItem {
  id: string; campaignId: string | null; title: string; channel: MarketingChannel; body: string;
  assetUrl: string | null; status: MarketingContentStatus; scheduledAt: Date | null; publishedAt: Date | null;
  provider: string | null; providerItemId: string | null; providerTargetId: string | null; providerTargetName: string | null;
  createdAt: Date; updatedAt: Date;
}
export interface MarketingApprovalEvent { id: string; entityType: "campaign" | "content"; entityId: string; action: string; note: string | null; createdAt: Date }
export interface MarketingContentRevision extends Omit<MarketingContentItem, "id" | "campaignId" | "status" | "publishedAt" | "provider" | "providerItemId" | "providerTargetId" | "providerTargetName" | "createdAt" | "updatedAt"> {
  id: string;
  version: number;
  savedAt: Date;
}
export interface RepurposeResult { items: MarketingContentItem[]; skippedChannels: MarketingChannel[]; usedFallback: boolean }

const CHANNEL_VALUES: MarketingChannel[] = ["email", "instagram", "facebook", "linkedin", "youtube", "blog", "landing_page", "search", "ad", "influencer", "event", "other"];
const RepurposeResponse = z.object({ items: z.array(z.object({
  channel: z.enum(["instagram", "facebook", "linkedin", "youtube", "blog", "landing_page", "search", "ad", "influencer", "event", "other"]),
  title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(30000),
})) });

const COLUMNS = "id, campaign_id, title, channel, body, asset_url, status, scheduled_at, published_at, provider, provider_item_id, provider_target_id, provider_target_name, created_at, updated_at";

export function mapContent(row: Record<string, unknown>): MarketingContentItem {
  return {
    id: row.id as string, campaignId: row.campaign_id as string | null, title: row.title as string,
    channel: row.channel as MarketingChannel, body: row.body as string, assetUrl: row.asset_url as string | null,
    status: row.status as MarketingContentStatus, scheduledAt: row.scheduled_at as Date | null,
    publishedAt: row.published_at as Date | null, provider: row.provider as string | null,
    providerItemId: row.provider_item_id as string | null, providerTargetId: row.provider_target_id as string | null,
    providerTargetName: row.provider_target_name as string | null, createdAt: row.created_at as Date, updatedAt: row.updated_at as Date,
  };
}

export async function listMarketingContent(userId: string, from?: Date, to?: Date): Promise<MarketingContentItem[]> {
  const result = await query(
    `SELECT ${COLUMNS} FROM sales_marketing_content_items
      WHERE user_id=$1 AND ($2::timestamptz IS NULL OR scheduled_at >= $2)
        AND ($3::timestamptz IS NULL OR scheduled_at < $3)
      ORDER BY scheduled_at NULLS LAST, created_at DESC LIMIT 250`,
    [userId, from ?? null, to ?? null],
  );
  return result.rows.map((row) => mapContent(row as Record<string, unknown>));
}

export async function getMarketingContentItem(userId: string, id: string): Promise<MarketingContentItem> {
  const result = await query(`SELECT ${COLUMNS} FROM sales_marketing_content_items WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!result.rows[0]) throw new NotFoundError("Marketing content");
  return mapContent(result.rows[0] as Record<string, unknown>);
}

export async function beginMarketingContentPublish(userId: string, id: string, provider: string, target: { id: string; name: string }): Promise<MarketingContentItem> {
  return withTransaction(async (client) => {
    const current = await client.query(`SELECT ${COLUMNS} FROM sales_marketing_content_items WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, userId]);
    if (!current.rows[0]) throw new NotFoundError("Marketing content");
    const item = mapContent(current.rows[0] as Record<string, unknown>);
    if (item.status === "publishing" || item.status === "publish_review") {
      throw new AppError("A provider publish may already have run. Check the provider first; Interlink will not retry it automatically.", 409);
    }
    if (!(["approved", "planned"] as MarketingContentStatus[]).includes(item.status)) {
      throw new AppError("Submit and approve this content before publishing it.", 409);
    }
    const result = await client.query(
      `UPDATE sales_marketing_content_items
          SET status='publishing',provider=$3,provider_item_id=NULL,provider_target_id=$4,provider_target_name=$5,updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status=ANY($6::text[]) RETURNING ${COLUMNS}`,
      [id, userId, provider, target.id, target.name.slice(0, 200), ["approved", "planned"]],
    );
    if (!result.rows[0]) throw new AppError("This content changed before publishing began. Refresh and review it again.", 409);
    await client.query(
      `UPDATE sales_marketing_social_publish_schedules SET status='cancelled',dispatch_claimed_at=NULL,updated_at=now()
        WHERE user_id=$1 AND content_item_id=$2 AND status IN ('pending','dispatching','queued')`, [userId, id],
    );
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES($1,'content',$2,'publish_started',$3)`,
      [userId, id, `User confirmed an immediate ${provider} publish to ${target.name.slice(0, 200)}.`],
    );
    return mapContent(result.rows[0] as Record<string, unknown>);
  });
}

export async function finishMarketingContentPublish(userId: string, id: string, providerItemId: string): Promise<MarketingContentItem> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE sales_marketing_content_items SET status='published',published_at=now(),provider_item_id=$3,updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status='publishing' RETURNING ${COLUMNS}`,
      [id, userId, providerItemId.slice(0, 500)],
    );
    if (!result.rows[0]) throw new AppError("The provider returned a post ID but the local calendar changed. Review the provider and content history.", 409);
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES($1,'content',$2,'published',$3)`,
      [userId, id, `Provider confirmed publication to ${String(result.rows[0].provider_target_name ?? "the selected account").slice(0, 200)}.`],
    );
    await client.query(
      `UPDATE sales_marketing_social_publish_schedules SET status='completed',dispatch_claimed_at=NULL,updated_at=now()
        WHERE user_id=$1 AND content_item_id=$2 AND status='publishing'`, [userId, id],
    );
    return mapContent(result.rows[0] as Record<string, unknown>);
  });
}

export async function flagMarketingContentPublishReview(userId: string, id: string, reason: string): Promise<MarketingContentItem> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE sales_marketing_content_items SET status='publish_review',updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status='publishing' RETURNING ${COLUMNS}`,
      [id, userId],
    );
    if (!result.rows[0]) throw new AppError("The publish request changed while it was being checked. Refresh the calendar.", 409);
    const safeReason = reason.trim().slice(0, 500) || "The provider did not confirm a post ID. Check the provider before retrying.";
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES($1,'content',$2,'publish_review',$3)`, [userId, id, safeReason],
    );
    await client.query(
      `UPDATE sales_marketing_social_publish_schedules SET status='review',dispatch_claimed_at=NULL,updated_at=now()
        WHERE user_id=$1 AND content_item_id=$2 AND status='publishing'`, [userId, id],
    );
    return mapContent(result.rows[0] as Record<string, unknown>);
  });
}

export async function requeueMarketingContentPublish(userId: string, id: string, confirmedNoPost: boolean): Promise<MarketingContentItem> {
  if (!confirmedNoPost) throw new AppError("Confirm that you checked the provider and no post was created.", 400);
  return withTransaction(async (client) => {
    const current = await client.query(`SELECT ${COLUMNS} FROM sales_marketing_content_items WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, userId]);
    if (!current.rows[0]) throw new NotFoundError("Marketing content");
    const item = mapContent(current.rows[0] as Record<string, unknown>);
    if (!(item.status === "publishing" || item.status === "publish_review") || item.providerItemId) {
      throw new AppError("Only an unresolved publish request without a saved provider post ID can be retried.", 409);
    }
    const restoredStatus = item.scheduledAt ? "planned" : "approved";
    const result = await client.query(
      `UPDATE sales_marketing_content_items
          SET status=$3,provider=NULL,provider_target_id=NULL,provider_target_name=NULL,updated_at=now()
        WHERE id=$1 AND user_id=$2 RETURNING ${COLUMNS}`,
      [id, userId, restoredStatus],
    );
    await client.query(
      `UPDATE sales_marketing_social_publish_schedules SET status='cancelled',dispatch_claimed_at=NULL,updated_at=now()
        WHERE user_id=$1 AND content_item_id=$2 AND status IN ('pending','dispatching','queued','publishing','review')`, [userId, id],
    );
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES($1,'content',$2,'publish_retried','User confirmed they checked the provider and no post exists; returned content to the previously approved state.')`,
      [userId, id],
    );
    return mapContent(result.rows[0] as Record<string, unknown>);
  });
}

export async function listMarketingApprovalHistory(userId: string, entityType: "campaign" | "content", entityId: string): Promise<MarketingApprovalEvent[]> {
  const result = await query(
    `SELECT id,entity_type,entity_id,action,note,created_at FROM sales_marketing_approval_events
     WHERE user_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY created_at DESC LIMIT 50`,
    [userId, entityType, entityId],
  );
  return result.rows.map((row) => ({
    id: row.id as string, entityType: row.entity_type as "campaign" | "content", entityId: row.entity_id as string,
    action: row.action as string, note: row.note as string | null, createdAt: row.created_at as Date,
  }));
}

export async function listMarketingContentRevisions(userId: string, contentId: string): Promise<MarketingContentRevision[]> {
  const result = await query(
    `SELECT id,version,title,channel,body,asset_url,scheduled_at,saved_at
       FROM sales_marketing_content_revisions
      WHERE user_id=$1 AND content_id=$2
      ORDER BY version DESC LIMIT 50`,
    [userId, contentId],
  );
  return result.rows.map((row) => ({
    id: row.id as string, version: row.version as number, title: row.title as string,
    channel: row.channel as MarketingChannel, body: row.body as string,
    assetUrl: row.asset_url as string | null, scheduledAt: row.scheduled_at as Date | null,
    savedAt: row.saved_at as Date,
  }));
}

async function insertContentRevision(
  client: PoolClient,
  userId: string,
  contentId: string,
  item: MarketingContentItem,
): Promise<void> {
  const versionResult = await client.query<{ next_version: number }>(
    `SELECT COALESCE(MAX(version),0)+1 AS next_version
       FROM sales_marketing_content_revisions WHERE content_id=$1`,
    [contentId],
  );
  await client.query(
    `INSERT INTO sales_marketing_content_revisions
      (user_id,content_id,version,title,channel,body,asset_url,scheduled_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, contentId, versionResult.rows[0].next_version, item.title, item.channel, item.body, item.assetUrl, item.scheduledAt],
  );
}

export async function createMarketingContent(userId: string, input: {
  campaignId?: string; title: string; channel: MarketingChannel; body?: string; assetUrl?: string; scheduledAt?: Date;
}): Promise<MarketingContentItem> {
  return withTransaction(async (client) => {
    if (input.campaignId) {
      const campaign = await client.query("SELECT 1 FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2", [input.campaignId, userId]);
      if (!campaign.rows[0]) throw new NotFoundError("Campaign");
    }
    const result = await client.query(
      `INSERT INTO sales_marketing_content_items (user_id,campaign_id,title,channel,body,asset_url,scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${COLUMNS}`,
      [userId, input.campaignId ?? null, input.title.trim(), input.channel, input.body ?? "", input.assetUrl ?? null, input.scheduledAt ?? null],
    );
    const item = mapContent(result.rows[0] as Record<string, unknown>);
    await insertContentRevision(client, userId, item.id, item);
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES($1,'content',$2,'created','Draft created in the Interlink content calendar.')`,
      [userId, item.id],
    );
    return item;
  });
}

function fallbackRepurpose(channel: MarketingChannel, topic: string, subject: string, body: string) {
  const title = `${topic} · ${channel.replace("_", " ")}`.slice(0, 200);
  const source = body.trim();
  const drafts: Record<MarketingChannel, string> = {
    email: source,
    instagram: `${source}\n\nLearn more: [Add link]`,
    facebook: `${source}\n\nLearn more: [Add link]`,
    linkedin: `${source}\n\nLearn more: [Add link]`,
    youtube: `Title: ${subject}\n\nDescription:\n${source}\n\nAdd the final video link and any required disclosures before publishing.`,
    blog: `# ${topic}\n\n${source}\n\n## Learn more\n[Add a verified next step or link]`,
    landing_page: `# ${subject}\n\n${source}\n\n## Next step\n[Add a verified call to action]`,
    search: `Search content brief: ${source}\n\nAdd verified keywords and destination URLs before publishing.`,
    ad: `Ad copy draft: ${source}\n\nConfirm claims, destination URL, targeting, and budget before launch.`,
    influencer: `Creator brief for ${topic}:\n\n${source}\n\nConfirm creator fit, deliverables, fee, and disclosure before outreach.`,
    event: `Event promotion for ${topic}:\n\n${source}\n\nAdd date, location, registration link, and accessibility details before publishing.`,
    other: source,
  };
  return { channel, title, body: drafts[channel] };
}

export async function repurposeMarketingCampaign(
  userId: string,
  campaignId: string,
  requestedChannels?: MarketingChannel[],
): Promise<RepurposeResult> {
  const campaignResult = await query(
    `SELECT topic,subject,body,objective,offer,success_metric,channels FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`,
    [campaignId, userId],
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) throw new NotFoundError("Campaign");
  const plannedChannels = Array.isArray(campaign.channels) ? campaign.channels as MarketingChannel[] : [];
  const channels = [...new Set((requestedChannels?.length ? requestedChannels : plannedChannels)
    .filter((channel) => channel !== "email" && CHANNEL_VALUES.includes(channel)))];
  if (!channels.length) return { items: [], skippedChannels: [], usedFallback: false };

  const current = await query<{ channel: MarketingChannel }>(
    `SELECT DISTINCT channel FROM sales_marketing_content_items
      WHERE user_id=$1 AND campaign_id=$2 AND status<>'cancelled' AND channel=ANY($3::text[])`,
    [userId, campaignId, channels],
  );
  const existing = new Set(current.rows.map((row) => row.channel));
  const toDraft = channels.filter((channel) => !existing.has(channel));
  if (!toDraft.length) return { items: [], skippedChannels: channels, usedFallback: false };

  let usedFallback = !isGeminiLive();
  let drafts: { channel: MarketingChannel; title: string; body: string }[] = [];
  if (!usedFallback) {
    try {
      const result = await geminiGenerateContent({
        system: "You are a marketing content editor. Repurpose the supplied campaign source into exactly one draft for each requested channel. Keep facts grounded in the source, do not create claims, pricing, dates, URLs, testimonials, or results. Use placeholders where details are missing. Keep each format appropriate to its channel. These are internal drafts, never schedule or publish. Return JSON only as {items:[{channel,title,body}]}.",
        parts: [{ text: JSON.stringify({
          topic: campaign.topic, objective: campaign.objective, offer: campaign.offer,
          successMeasure: campaign.success_metric, emailSubject: campaign.subject,
          approvedSourceCopy: campaign.body, requestedChannels: toDraft,
        }) }],
        json: true,
        maxOutputTokens: Math.min(5000, 500 + toDraft.length * 400),
      });
      const parsed = RepurposeResponse.safeParse(JSON.parse(result.raw));
      if (!parsed.success || parsed.data.items.length !== toDraft.length || new Set(parsed.data.items.map((item) => item.channel)).size !== toDraft.length ||
        toDraft.some((channel) => !parsed.data.items.some((item) => item.channel === channel))) throw new Error("The channel drafts were incomplete.");
      drafts = parsed.data.items;
    } catch {
      usedFallback = true;
    }
  }
  if (usedFallback) {
    drafts = toDraft.map((channel) => fallbackRepurpose(channel, campaign.topic as string, campaign.subject as string, campaign.body as string));
  }

  const transaction = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`marketing-repurpose:${userId}:${campaignId}`]);
    const alreadyCreated = await client.query<{ channel: MarketingChannel }>(
      `SELECT DISTINCT channel FROM sales_marketing_content_items
        WHERE user_id=$1 AND campaign_id=$2 AND status<>'cancelled' AND channel=ANY($3::text[])`,
      [userId, campaignId, channels],
    );
    const existingNow = new Set(alreadyCreated.rows.map((row) => row.channel));
    const inserted: MarketingContentItem[] = [];
    for (const draft of drafts) {
      if (existingNow.has(draft.channel)) continue;
      const result = await client.query(
        `INSERT INTO sales_marketing_content_items(user_id,campaign_id,title,channel,body)
         VALUES($1,$2,$3,$4,$5) RETURNING ${COLUMNS}`,
        [userId, campaignId, draft.title, draft.channel, draft.body],
      );
      const item = mapContent(result.rows[0] as Record<string, unknown>);
      await insertContentRevision(client, userId, item.id, item);
      await client.query(
        `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
         VALUES($1,'content',$2,'created','Draft generated from campaign source copy for review.')`,
        [userId, item.id],
      );
      inserted.push(item);
    }
    return { inserted, existingNow };
  });
  return {
    items: transaction.inserted,
    skippedChannels: channels.filter((channel) => transaction.existingNow.has(channel) || !transaction.inserted.some((item) => item.channel === channel)),
    usedFallback,
  };
}

export async function updateMarketingContent(userId: string, id: string, patch: {
  title?: string; channel?: MarketingChannel; body?: string; assetUrl?: string | null; scheduledAt?: Date | null;
}): Promise<MarketingContentItem> {
  if (!Object.values(patch).some((value) => value !== undefined)) throw new AppError("Choose at least one content field to update.", 400);
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT id,status FROM sales_marketing_content_items
        WHERE id=$1 AND user_id=$2 AND status IN ('draft','in_review','approved','planned') FOR UPDATE`,
      [id, userId],
    );
    if (!current.rows[0]) throw new NotFoundError("Editable marketing content");
    const substantiveEdit = patch.title !== undefined || patch.channel !== undefined ||
      patch.body !== undefined || patch.assetUrl !== undefined;
    const resetApproval = shouldResetMarketingContentApproval(current.rows[0].status as MarketingContentStatus, substantiveEdit);
    const removedPlan = patch.scheduledAt === null && current.rows[0].status === "planned" && !resetApproval;
    const result = await client.query(
      `UPDATE sales_marketing_content_items SET
         status=CASE WHEN $10::boolean AND status IN ('in_review','approved','planned') THEN 'draft'
                     WHEN $8::boolean AND $9::timestamptz IS NULL AND status='planned' THEN 'approved'
                     ELSE status END,
         title=COALESCE($3,title), channel=COALESCE($4,channel),
         body=COALESCE($5,body), asset_url=CASE WHEN $6::boolean THEN $7 ELSE asset_url END,
         scheduled_at=CASE WHEN $10::boolean AND status='planned' THEN NULL
                           WHEN $8::boolean AND $9::timestamptz IS NULL AND status='planned' THEN NULL
                           WHEN $8::boolean THEN $9 ELSE scheduled_at END,
         provider=CASE WHEN $10::boolean OR ($8::boolean AND status='planned') THEN NULL ELSE provider END,
         provider_target_id=CASE WHEN $10::boolean OR ($8::boolean AND status='planned') THEN NULL ELSE provider_target_id END,
         provider_target_name=CASE WHEN $10::boolean OR ($8::boolean AND status='planned') THEN NULL ELSE provider_target_name END,
         updated_at=now()
       WHERE id=$1 AND user_id=$2 RETURNING ${COLUMNS}`,
      [id, userId, patch.title?.trim() ?? null, patch.channel ?? null, patch.body ?? null,
        patch.assetUrl !== undefined, patch.assetUrl ?? null, patch.scheduledAt !== undefined, patch.scheduledAt ?? null,
        resetApproval],
    );
    const item = mapContent(result.rows[0] as Record<string, unknown>);
    if (resetApproval || (patch.scheduledAt !== undefined && current.rows[0].status === "planned")) {
      await client.query(
        `UPDATE sales_marketing_social_publish_schedules SET status='cancelled',dispatch_claimed_at=NULL,updated_at=now()
          WHERE user_id=$1 AND content_item_id=$2 AND status IN ('pending','dispatching','queued')`, [userId, id],
      );
    }
    await insertContentRevision(client, userId, item.id, item);
    const fields = [
      patch.title !== undefined ? "title" : null, patch.channel !== undefined ? "channel" : null,
      patch.body !== undefined ? "copy" : null, patch.assetUrl !== undefined ? "asset" : null,
      patch.scheduledAt !== undefined ? "planned date" : null,
    ].filter(Boolean);
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES($1,'content',$2,'edited',$3)`,
      [userId, item.id, `${fields.length ? `Updated ${fields.join(", ")}. ` : ""}Revision saved.${resetApproval ? " Prior review approval and calendar plan were cleared; resubmit this version for review." : removedPlan ? " Calendar time was removed; approval remains valid." : ""}`],
    );
    return item;
  });
}

async function transition(
  userId: string, id: string, from: MarketingContentStatus[], to: MarketingContentStatus,
  event: string, note?: string, scheduledAt?: Date, provider?: string, providerItemId?: string,
): Promise<MarketingContentItem> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE sales_marketing_content_items SET status=$4,
         scheduled_at=CASE WHEN $5::timestamptz IS NOT NULL THEN $5 ELSE scheduled_at END,
         published_at=CASE WHEN $4='published' THEN now() ELSE published_at END,
         provider=COALESCE($6,provider), provider_item_id=COALESCE($7,provider_item_id), updated_at=now()
       WHERE id=$1 AND user_id=$2 AND status=ANY($3::text[]) RETURNING ${COLUMNS}`,
      [id, userId, from, to, scheduledAt ?? null, provider ?? null, providerItemId ?? null],
    );
    if (!result.rows[0]) throw new AppError("That content item cannot move to this stage. Refresh it and try again.", 409);
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES ($1,'content',$2,$3,$4)`, [userId, id, event, note ?? null],
    );
    if (to === "cancelled") {
      await client.query(
        `UPDATE sales_marketing_social_publish_schedules SET status='cancelled',dispatch_claimed_at=NULL,updated_at=now()
          WHERE user_id=$1 AND content_item_id=$2 AND status IN ('pending','dispatching','queued')`, [userId, id],
      );
    } else if (to === "published" || to === "completed") {
      await client.query(
        `UPDATE sales_marketing_social_publish_schedules SET status='completed',dispatch_claimed_at=NULL,updated_at=now()
          WHERE user_id=$1 AND content_item_id=$2 AND status IN ('pending','dispatching','queued','publishing','review')`, [userId, id],
      );
    }
    return mapContent(result.rows[0] as Record<string, unknown>);
  });
}

export function submitMarketingContent(userId: string, id: string) {
  return transition(userId, id, ["draft"], "in_review", "submitted");
}
export function approveMarketingContent(userId: string, id: string, note?: string) {
  return transition(userId, id, ["in_review"], "approved", "approved", note);
}
export function planMarketingContent(userId: string, id: string, scheduledAt: Date) {
  return transition(userId, id, ["approved"], "planned", "scheduled", "Planned in Interlink's content calendar; provider scheduling is a separate confirmed action.", scheduledAt);
}
export function markMarketingContentPublished(userId: string, id: string, provider: string, providerItemId?: string) {
  return transition(userId, id, ["approved", "planned", "publishing", "publish_review"], "published", "published", "User verified provider publication.", undefined, provider, providerItemId);
}
export function completeMarketingContent(userId: string, id: string, provider: string, providerItemId?: string) {
  return transition(userId, id, ["approved", "planned"], "completed", "completed", "User recorded completion of this marketing activity.", undefined, provider, providerItemId);
}
export function cancelMarketingContent(userId: string, id: string) {
  return transition(userId, id, ["draft", "in_review", "approved", "planned"], "cancelled", "cancelled");
}
