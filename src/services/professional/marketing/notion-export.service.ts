import { query } from "../../../config/db";
import { AppError, NotFoundError } from "../../../utils/errors";
import { createDataSourcePage, createPage, getDataSource, queryDataSourceMarker, searchDataSources, searchPages, type NotionDataSource, type NotionDataSourceProperty, type NotionPage } from "../../notion/notion.service";
import { validateMarketingNotionMapping, type MarketingNotionField, type MarketingNotionMapping } from "./notion-export.model";
export type { MarketingNotionField, MarketingNotionMapping } from "./notion-export.model";
export type MarketingNotionExportState = {
  status: "creating" | "review" | "synced";
  pageId: string | null;
  pageUrl: string | null;
  dataSourceId: string;
  mapping: MarketingNotionMapping;
  updatedAt: string;
};

function propertiesForCampaign(campaign: Record<string, unknown>, mapping: MarketingNotionMapping, titleProperty: string): Record<string, unknown> {
  const title = String(campaign.topic ?? "Campaign");
  const props: Record<string, unknown> = { [titleProperty]: { title: [{ text: { content: title.slice(0, 2000) } }] } };
  const values: Record<MarketingNotionField, unknown> = {
    campaignId: String(campaign.id), objective: campaign.objective, audience: campaign.audience, offer: campaign.offer,
    successMetric: campaign.success_metric, channels: Array.isArray(campaign.channels) ? campaign.channels : [],
    startDate: campaign.start_date, endDate: campaign.end_date,
    budget: campaign.budget_cents === null || campaign.budget_cents === undefined ? null : Number(campaign.budget_cents) / 100,
  };
  for (const [field, property] of Object.entries(mapping) as [MarketingNotionField, string | null][]) {
    if (!property) continue;
    const value = values[field];
    if (value === null || value === undefined || value === "") continue;
    if (field === "channels" && Array.isArray(value)) {
      props[property] = { rich_text: [{ text: { content: value.join(", ").slice(0, 2000) } }] };
    } else if (field === "startDate" || field === "endDate") {
      const date = new Date(value as string | Date).toISOString().slice(0, 10);
      props[property] = { date: { start: date } };
    } else if (field === "budget") {
      props[property] = { number: value };
    } else {
      props[property] = { rich_text: [{ text: { content: String(value).slice(0, 2000) } }] };
    }
  }
  return props;
}

async function requireCampaign(userId: string, campaignId: string): Promise<Record<string, unknown>> {
  const result = await query(
    `SELECT id,topic,audience,objective,offer,success_metric,channels,start_date,end_date,budget_cents,subject,body
       FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`, [campaignId, userId],
  );
  if (!result.rows[0]) throw new NotFoundError("Campaign");
  return result.rows[0] as Record<string, unknown>;
}

async function validateMapping(userId: string, dataSourceId: string, mapping: MarketingNotionMapping): Promise<{ titleProperty: string }> {
  const schema = await getDataSource(userId, dataSourceId);
  try { return { titleProperty: validateMarketingNotionMapping(mapping, schema.properties) }; }
  catch (error) { throw new AppError(error instanceof Error ? error.message : "The Notion property mapping is invalid.", 400); }
}

async function createMappedRow(userId: string, campaignId: string, dataSourceId: string, mapping: MarketingNotionMapping, titleProperty: string): Promise<NotionPage> {
  const campaign = await requireCampaign(userId, campaignId);
  const title = `[Interlink] ${String(campaign.topic).slice(0, 160)}`;
  const formatDate = (value: unknown) => value ? new Date(value as string | Date).toISOString().slice(0, 10) : "Not planned";
  const budget = campaign.budget_cents === null || campaign.budget_cents === undefined ? "Not planned" : `USD ${(Number(campaign.budget_cents) / 100).toFixed(2)} (planning budget)`;
  const body = [
    `# Campaign brief: ${campaign.topic}`, `## Objective\n${campaign.objective || "Not specified"}`,
    `## Audience\n${campaign.audience || "Not specified"}`, `## Offer or key message\n${campaign.offer || "Not specified"}`,
    `## Success measure\n${campaign.success_metric || "Not specified"}`,
    `## Channels\n${Array.isArray(campaign.channels) ? campaign.channels.join(", ") : "Not specified"}`,
    `## Schedule\n${formatDate(campaign.start_date)} through ${formatDate(campaign.end_date)}`,
    `## Planning budget\n${budget}`, `## Email draft\nSubject: ${campaign.subject}\n\n${campaign.body}`,
    "## Review note\nValidate claims, audience fit, consent, and provider requirements before publishing or sending.",
    `Interlink campaign ID: ${campaignId}`,
  ].join("\n\n");
  return createDataSourcePage(userId, dataSourceId, propertiesForCampaign(campaign, mapping, titleProperty), body, title);
}

export async function searchMarketingNotionParents(userId: string, campaignId: string, search: string): Promise<NotionPage[]> {
  const queryText = search.trim();
  if (queryText.length < 2) throw new AppError("Enter at least two characters to search Notion pages.", 400);
  const campaign = await query(`SELECT 1 FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`, [campaignId, userId]);
  if (!campaign.rows[0]) throw new NotFoundError("Campaign");
  return searchPages(userId, queryText);
}

/** Export one reviewable snapshot of a campaign brief to a user-selected Notion page. */
export async function exportMarketingCampaignToNotion(
  userId: string,
  campaignId: string,
  parentId: string,
): Promise<{ page: NotionPage; alreadyExported: boolean }> {
  const result = await query(
    `SELECT topic,audience,objective,offer,success_metric,channels,start_date,end_date,budget_cents,subject,body
       FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`, [campaignId, userId],
  );
  const campaign = result.rows[0];
  if (!campaign) throw new NotFoundError("Campaign");

  const title = `[Interlink campaign] ${String(campaign.topic).slice(0, 140)} (${campaignId.slice(0, 8)})`;
  const existing = (await searchPages(userId, title)).find((page) => page.title === title);
  if (existing) return { page: existing, alreadyExported: true };

  const formatDate = (value: Date | string | null) => value ? new Date(value).toISOString().slice(0, 10) : "Not planned";
  const budget = campaign.budget_cents === null || campaign.budget_cents === undefined
    ? "Not planned"
    : `USD ${(Number(campaign.budget_cents) / 100).toFixed(2)} (planning amount; not actual spend)`;
  const channels = Array.isArray(campaign.channels) ? campaign.channels.join(", ") : "Not specified";
  const content = [
    `# Campaign brief: ${campaign.topic}`,
    `## Objective\n${campaign.objective || "Not specified"}`,
    `## Audience\n${campaign.audience || "Not specified"}`,
    `## Offer or key message\n${campaign.offer || "Not specified"}`,
    `## Success measure\n${campaign.success_metric || "Not specified"}`,
    `## Channels\n${channels}`,
    `## Schedule\n${formatDate(campaign.start_date)} through ${formatDate(campaign.end_date)}`,
    `## Planning budget\n${budget}`,
    `## Email draft\nSubject: ${campaign.subject}\n\n${campaign.body}`,
    "## Review note\nValidate claims, audience fit, consent, and provider requirements before publishing or sending.",
    `Interlink campaign ID: ${campaignId}`,
  ].join("\n\n");
  const page = await createPage(userId, { parentId, title, content });
  return { page, alreadyExported: false };
}

export async function searchMarketingNotionDataSources(userId: string, campaignId: string, search: string): Promise<NotionDataSource[]> {
  const queryText = search.trim();
  if (queryText.length < 2) throw new AppError("Enter at least two characters to search Notion databases.", 400);
  await requireCampaign(userId, campaignId);
  return searchDataSources(userId, queryText);
}

export async function getMarketingNotionDataSourceSchema(userId: string, campaignId: string, dataSourceId: string): Promise<{ id: string; properties: NotionDataSourceProperty[] }> {
  await requireCampaign(userId, campaignId);
  return getDataSource(userId, dataSourceId);
}

export async function getMarketingNotionExport(userId: string, campaignId: string): Promise<MarketingNotionExportState | null> {
  await requireCampaign(userId, campaignId);
  const result = await query(
    `SELECT status,notion_page_id,notion_page_url,data_source_id,property_mapping,updated_at
       FROM sales_marketing_notion_campaign_exports WHERE campaign_id=$1 AND user_id=$2`, [campaignId, userId],
  );
  const row = result.rows[0];
  return row ? {
    status: row.status,
    pageId: row.notion_page_id ?? null,
    pageUrl: row.notion_page_url ?? null,
    dataSourceId: row.data_source_id,
    mapping: row.property_mapping,
    updatedAt: new Date(row.updated_at).toISOString(),
  } : null;
}

async function beginExport(userId: string, campaignId: string, dataSource: NotionDataSource, mapping: MarketingNotionMapping): Promise<MarketingNotionExportState | null> {
  const validated = await validateMapping(userId, dataSource.id, mapping);
  const inserted = await query(
    `INSERT INTO sales_marketing_notion_campaign_exports (user_id,campaign_id,data_source_id,database_id,property_mapping,marker_property,status)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,'creating') ON CONFLICT (user_id,campaign_id) DO NOTHING RETURNING id`,
    [userId, campaignId, dataSource.id, dataSource.databaseId, JSON.stringify(mapping), mapping.campaignId],
  );
  if (!inserted.rows[0]) return getMarketingNotionExport(userId, campaignId);
  try {
    const page = await createMappedRow(userId, campaignId, dataSource.id, mapping, validated.titleProperty);
    await query(
      `UPDATE sales_marketing_notion_campaign_exports SET status='synced',notion_page_id=$3,notion_page_url=$4,
          synced_at=now(),last_error_code=NULL,updated_at=now() WHERE campaign_id=$1 AND user_id=$2 AND status='creating'`,
      [campaignId, userId, page.id, page.url],
    );
  } catch {
    // A timeout or malformed provider response may follow a successful create. Never retry automatically.
    await query(
      `UPDATE sales_marketing_notion_campaign_exports SET status='review',last_error_code='notion_create_unconfirmed',updated_at=now()
       WHERE campaign_id=$1 AND user_id=$2 AND status='creating'`, [campaignId, userId],
    );
  }
  return getMarketingNotionExport(userId, campaignId);
}

export async function exportMarketingCampaignToNotionDataSource(
  userId: string, campaignId: string, dataSource: NotionDataSource, mapping: MarketingNotionMapping,
): Promise<MarketingNotionExportState | null> {
  await requireCampaign(userId, campaignId);
  if (!dataSource?.id || !dataSource.databaseId) throw new AppError("Choose a Notion database destination.", 400);
  return beginExport(userId, campaignId, dataSource, mapping);
}

export async function reconcileMarketingNotionExport(
  userId: string, campaignId: string, confirmNoExistingRow: boolean,
): Promise<{ state: MarketingNotionExportState | null; matches: NotionPage[]; canRetry: boolean }> {
  const state = await getMarketingNotionExport(userId, campaignId);
  if (!state) throw new AppError("This campaign has no Notion database export to review.", 404);
  if (state.status === "synced") return { state, matches: state.pageId ? [{ id: state.pageId, url: state.pageUrl ?? "", title: "Campaign row", lastEdited: "" }] : [], canRetry: false };
  if (state.status === "creating") {
    const stale = await query(
      `UPDATE sales_marketing_notion_campaign_exports SET status='review',last_error_code='notion_create_unconfirmed',updated_at=now()
       WHERE campaign_id=$1 AND user_id=$2 AND status='creating' AND started_at < now() - interval '2 minutes' RETURNING id`,
      [campaignId, userId],
    );
    if (!stale.rows[0]) throw new AppError("The Notion create request is still unresolved. Wait two minutes, then check the campaign marker in Notion again.", 409);
  }
  const matches = await queryDataSourceMarker(userId, state.dataSourceId, state.mapping.campaignId, campaignId);
  if (matches.length === 1) {
    await query(
      `UPDATE sales_marketing_notion_campaign_exports SET status='synced',notion_page_id=$3,notion_page_url=$4,
          synced_at=now(),last_error_code=NULL,updated_at=now() WHERE campaign_id=$1 AND user_id=$2 AND status='review'`,
      [campaignId, userId, matches[0].id, matches[0].url],
    );
    return { state: await getMarketingNotionExport(userId, campaignId), matches, canRetry: false };
  }
  if (matches.length > 1) return { state, matches, canRetry: false };
  if (!confirmNoExistingRow) return { state, matches, canRetry: true };

  const claim = await query(
    `UPDATE sales_marketing_notion_campaign_exports SET status='creating',started_at=now(),last_error_code=NULL,updated_at=now()
     WHERE campaign_id=$1 AND user_id=$2 AND status='review' RETURNING data_source_id,property_mapping`, [campaignId, userId],
  );
  if (!claim.rows[0]) throw new AppError("This Notion export changed while it was being reviewed. Reload its status.", 409);
  const savedMapping = claim.rows[0].property_mapping as MarketingNotionMapping;
  try {
    const schema = await validateMapping(userId, String(claim.rows[0].data_source_id), savedMapping);
    const page = await createMappedRow(userId, campaignId, String(claim.rows[0].data_source_id), savedMapping, schema.titleProperty);
    await query(
      `UPDATE sales_marketing_notion_campaign_exports SET status='synced',notion_page_id=$3,notion_page_url=$4,
          synced_at=now(),last_error_code=NULL,updated_at=now() WHERE campaign_id=$1 AND user_id=$2 AND status='creating'`,
      [campaignId, userId, page.id, page.url],
    );
  } catch {
    await query(
      `UPDATE sales_marketing_notion_campaign_exports SET status='review',last_error_code='notion_create_unconfirmed',updated_at=now()
       WHERE campaign_id=$1 AND user_id=$2 AND status='creating'`, [campaignId, userId],
    );
  }
  return { state: await getMarketingNotionExport(userId, campaignId), matches: [], canRetry: false };
}
