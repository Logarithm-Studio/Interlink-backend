import { query, withTransaction } from "../../../config/db";
import { AppError, NotFoundError } from "../../../utils/errors";
import type { MarketingActivationCreateInput, MarketingActivationPatchInput } from "./activation.model";
import {
  mapMarketingActivationCrmOutcomes,
  type MarketingActivationContractOutcomeRow,
  type MarketingActivationDealOutcomeRow,
} from "./activation-outcomes.model";

export type MarketingActivationType = "event" | "influencer";
export type MarketingActivationStatus = "planned" | "in_progress" | "completed" | "cancelled";

export interface MarketingActivation {
  id: string;
  campaignId: string | null;
  campaignTopic: string | null;
  type: MarketingActivationType;
  name: string;
  owner: string | null;
  deliverables: string;
  date: string | null;
  plannedCost: string | null;
  actualCost: string | null;
  currency: string;
  url: string | null;
  trackedLinkEnabled: boolean;
  trackedRedirects: number;
  outcome: string;
  attributedLeads: number;
  crmOpportunities: number;
  crmWonDeals: number;
  crmPipelineByCurrency: { currency: string; amountCents: number }[];
  crmClosedWonByCurrency: { currency: string; amountCents: number }[];
  crmSignedContractByCurrency: { currency: string; amountCents: number }[];
  reach: number | null;
  engagements: number | null;
  leads: number | null;
  conversions: number | null;
  status: MarketingActivationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface MarketingActivationEvent {
  id: string;
  activationId: string;
  action: "created" | "updated" | "status_changed";
  changedFields: string[];
  createdAt: Date;
}

const COLUMNS = `a.id,a.campaign_id,c.topic AS campaign_topic,a.activation_type,a.name,a.owner,a.deliverables,
  a.activation_date,a.planned_cost::text,a.actual_cost::text,a.currency,a.external_url,a.outcome,
  (a.public_link_token IS NOT NULL) AS tracked_link_enabled,
  COALESCE((SELECT SUM(link_metric.redirect_count)::text FROM sales_marketing_activation_link_metrics link_metric
    WHERE link_metric.user_id=a.user_id AND link_metric.activation_id=a.id),'0') AS tracked_redirects,
  a.reach_count,a.engagement_count,a.lead_count,a.conversion_count,
  (SELECT COUNT(DISTINCT touch.contact_id)::int FROM sales_marketing_contact_attributions touch
    WHERE touch.user_id=a.user_id AND touch.activation_id=a.id) AS attributed_leads,
  a.status,a.created_at,a.updated_at`;

function mapActivation(row: Record<string, unknown>): MarketingActivation {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string | null,
    campaignTopic: row.campaign_topic as string | null,
    type: row.activation_type as MarketingActivationType,
    name: row.name as string,
    owner: row.owner as string | null,
    deliverables: row.deliverables as string,
    date: row.activation_date instanceof Date ? row.activation_date.toISOString().slice(0, 10) : row.activation_date as string | null,
    plannedCost: row.planned_cost as string | null,
    actualCost: row.actual_cost as string | null,
    currency: String(row.currency).trim(),
    url: row.external_url as string | null,
    trackedLinkEnabled: row.tracked_link_enabled === true,
    trackedRedirects: Number(row.tracked_redirects ?? 0),
    outcome: row.outcome as string,
    attributedLeads: Number(row.attributed_leads ?? 0),
    crmOpportunities: 0,
    crmWonDeals: 0,
    crmPipelineByCurrency: [],
    crmClosedWonByCurrency: [],
    crmSignedContractByCurrency: [],
    reach: row.reach_count === null ? null : Number(row.reach_count),
    engagements: row.engagement_count === null ? null : Number(row.engagement_count),
    leads: row.lead_count === null ? null : Number(row.lead_count),
    conversions: row.conversion_count === null ? null : Number(row.conversion_count),
    status: row.status as MarketingActivationStatus,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

async function addActivationCrmOutcomes(userId: string, activations: MarketingActivation[]): Promise<MarketingActivation[]> {
  if (!activations.length) return activations;
  const activationIds = activations.map((activation) => activation.id);
  const [dealOutcomes, contractOutcomes] = await Promise.all([
    query<MarketingActivationDealOutcomeRow>(
      `WITH first_touches AS (
         SELECT activation_id,contact_id,MIN(captured_at) AS captured_at
           FROM sales_marketing_contact_attributions
          WHERE user_id=$1 AND activation_id=ANY($2::uuid[])
          GROUP BY activation_id,contact_id
       )
       SELECT ft.activation_id,d.currency,COUNT(*)::int AS opportunities,
         COUNT(*) FILTER (WHERE d.stage='won')::int AS crm_won_deals,
         COALESCE(SUM(d.amount_cents) FILTER (WHERE d.stage NOT IN ('won','lost')),0)::text AS pipeline_cents,
         COALESCE(SUM(d.amount_cents) FILTER (WHERE d.stage='won'),0)::text AS closed_won_cents
         FROM first_touches ft
         JOIN sales_deals d ON d.user_id=$1 AND d.contact_id=ft.contact_id AND d.created_at>=ft.captured_at
        GROUP BY ft.activation_id,d.currency`,
      [userId, activationIds],
    ),
    query<MarketingActivationContractOutcomeRow>(
      `WITH first_touches AS (
         SELECT activation_id,contact_id,MIN(captured_at) AS captured_at
           FROM sales_marketing_contact_attributions
          WHERE user_id=$1 AND activation_id=ANY($2::uuid[])
          GROUP BY activation_id,contact_id
       ), activation_deals AS (
         SELECT ft.activation_id,d.id AS deal_id
           FROM first_touches ft
           JOIN sales_deals d ON d.user_id=$1 AND d.contact_id=ft.contact_id AND d.created_at>=ft.captured_at
       )
       SELECT ad.activation_id,sc.currency,SUM(sc.amount_cents)::text AS signed_contract_cents
         FROM activation_deals ad
         JOIN sales_contracts sc ON sc.deal_id=ad.deal_id AND sc.user_id=$1 AND sc.status='signed'
        GROUP BY ad.activation_id,sc.currency`,
      [userId, activationIds],
    ),
  ]);
  const outcomes = mapMarketingActivationCrmOutcomes(dealOutcomes.rows, contractOutcomes.rows);

  return activations.map((activation) => {
    const outcome = outcomes.get(activation.id);
    return {
      ...activation,
      crmOpportunities: outcome?.opportunities ?? 0,
      crmWonDeals: outcome?.wonDeals ?? 0,
      crmPipelineByCurrency: outcome?.pipelineByCurrency ?? [],
      crmClosedWonByCurrency: outcome?.closedWonByCurrency ?? [],
      crmSignedContractByCurrency: outcome?.signedContractByCurrency ?? [],
    };
  });
}

export async function listMarketingActivations(userId: string): Promise<MarketingActivation[]> {
  const result = await query(
    `SELECT ${COLUMNS} FROM sales_marketing_activations a
       LEFT JOIN sales_marketing_campaigns c ON c.id=a.campaign_id AND c.user_id=a.user_id
      WHERE a.user_id=$1 ORDER BY a.activation_date NULLS LAST,a.updated_at DESC LIMIT 250`,
    [userId],
  );
  return addActivationCrmOutcomes(userId, result.rows.map((row) => mapActivation(row as Record<string, unknown>)));
}

export async function createMarketingActivation(userId: string, input: MarketingActivationCreateInput): Promise<MarketingActivation> {
  const activation = await withTransaction(async (client) => {
    if (input.campaignId) {
      const campaign = await client.query("SELECT 1 FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2", [input.campaignId, userId]);
      if (!campaign.rows[0]) throw new NotFoundError("Campaign");
    }
    const result = await client.query(
      `INSERT INTO sales_marketing_activations
        (user_id,campaign_id,activation_type,name,owner,deliverables,activation_date,planned_cost,actual_cost,currency,external_url,outcome,
         reach_count,engagement_count,lead_count,conversion_count,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [userId, input.campaignId ?? null, input.type, input.name, input.owner?.trim() || null, input.deliverables ?? "",
        input.date ?? null, input.plannedCost ?? null, input.actualCost ?? null, input.currency?.toUpperCase() ?? "USD",
        input.url ?? null, input.outcome ?? "", input.reach ?? null, input.engagements ?? null, input.leads ?? null,
        input.conversions ?? null, input.status ?? "planned"],
    );
    const saved = await client.query(
      `SELECT ${COLUMNS} FROM sales_marketing_activations a
         LEFT JOIN sales_marketing_campaigns c ON c.id=a.campaign_id AND c.user_id=a.user_id
        WHERE a.id=$1 AND a.user_id=$2`,
      [result.rows[0].id, userId],
    );
    const activation = mapActivation(saved.rows[0] as Record<string, unknown>);
    await client.query(
      `INSERT INTO sales_marketing_activation_events(user_id,activation_id,action,changed_fields)
       VALUES($1,$2,'created',$3::text[])`,
      [userId, activation.id, ["campaignId", "type", "name", "owner", "deliverables", "date", "plannedCost", "actualCost", "currency", "url", "outcome", "reach", "engagements", "leads", "conversions", "status"]],
    );
    return activation;
  });
  return (await addActivationCrmOutcomes(userId, [activation]))[0];
}

export async function updateMarketingActivation(userId: string, id: string, patch: MarketingActivationPatchInput): Promise<MarketingActivation> {
  const activation = await withTransaction(async (client) => {
    const current = await client.query(
      `SELECT ${COLUMNS} FROM sales_marketing_activations a
        LEFT JOIN sales_marketing_campaigns c ON c.id=a.campaign_id AND c.user_id=a.user_id
       WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE OF a`,
      [id, userId],
    );
    if (!current.rows[0]) throw new NotFoundError("Marketing activation");
    const before = mapActivation(current.rows[0] as Record<string, unknown>);
    if (patch.campaignId !== undefined && patch.campaignId !== before.campaignId) {
      const touches = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM sales_marketing_contact_attributions
          WHERE user_id=$1 AND activation_id=$2`,
        [userId, id],
      );
      if (Number(touches.rows[0]?.count ?? 0) > 0) {
        throw new AppError("This activation already has attributed CRM contacts, so its campaign link is locked to preserve their original attribution.", 409);
      }
    }
    if (patch.campaignId) {
      const campaign = await client.query("SELECT 1 FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2", [patch.campaignId, userId]);
      if (!campaign.rows[0]) throw new NotFoundError("Campaign");
    }

    const fields: Record<keyof MarketingActivationPatchInput, string> = {
      campaignId: "campaign_id", name: "name", owner: "owner", deliverables: "deliverables", date: "activation_date",
      plannedCost: "planned_cost", actualCost: "actual_cost", currency: "currency", url: "external_url", outcome: "outcome", status: "status",
      reach: "reach_count", engagements: "engagement_count", leads: "lead_count", conversions: "conversion_count",
    };
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof MarketingActivationPatchInput, unknown][];
    const invalidatesTrackedLink = patch.url !== undefined && patch.url !== before.url && before.trackedLinkEnabled;
    const values: unknown[] = [id, userId];
    const assignments = entries.map(([key, value]) => {
      const normalized = key === "currency" && typeof value === "string"
        ? value.toUpperCase()
        : key === "owner" && typeof value === "string" && !value.trim()
          ? null
          : value;
      values.push(normalized);
      return `${fields[key]}=$${values.length}`;
    });
    if (invalidatesTrackedLink) assignments.push("public_link_token=NULL");
    assignments.push("updated_at=now()");
    const result = await client.query(
      `UPDATE sales_marketing_activations SET ${assignments.join(",")}
        WHERE id=$1 AND user_id=$2
        RETURNING id`,
      values,
    );
    const saved = await client.query(
      `SELECT ${COLUMNS} FROM sales_marketing_activations a
         LEFT JOIN sales_marketing_campaigns c ON c.id=a.campaign_id AND c.user_id=a.user_id
        WHERE a.id=$1 AND a.user_id=$2`,
      [result.rows[0].id, userId],
    );
    const activation = mapActivation(saved.rows[0] as Record<string, unknown>);
    const action = patch.status !== undefined && patch.status !== before.status ? "status_changed" : "updated";
    await client.query(
      `INSERT INTO sales_marketing_activation_events(user_id,activation_id,action,changed_fields)
       VALUES($1,$2,$3,$4::text[])`,
      [userId, id, action, [...entries.map(([key]) => key), ...(invalidatesTrackedLink ? ["trackedLink"] : [])]],
    );
    return activation;
  });
  return (await addActivationCrmOutcomes(userId, [activation]))[0];
}

export async function listMarketingActivationEvents(userId: string, activationId: string): Promise<MarketingActivationEvent[]> {
  const activation = await query("SELECT 1 FROM sales_marketing_activations WHERE id=$1 AND user_id=$2", [activationId, userId]);
  if (!activation.rows[0]) throw new NotFoundError("Marketing activation");
  const result = await query(
    `SELECT id,activation_id,action,changed_fields,created_at FROM sales_marketing_activation_events
      WHERE user_id=$1 AND activation_id=$2 ORDER BY created_at DESC LIMIT 50`,
    [userId, activationId],
  );
  return result.rows.map((row) => ({
    id: row.id as string, activationId: row.activation_id as string,
    action: row.action as MarketingActivationEvent["action"], changedFields: row.changed_fields as string[],
    createdAt: row.created_at as Date,
  }));
}
