/**
 * Sales & Business Development vertical (Professional Mode, incl. merged Marketing).
 *
 * Self-contained CRM (contacts, deals, activities, reps, contracts) + the 5 PRD
 * workflows implemented with Gemini + Gmail + Google Calendar:
 *   1. Lead enrichment   2. Post-meeting follow-up   3. Contract generation
 *   4. Inbound routing    5. Pipeline cleaning (autonomy)
 */

import { randomUUID } from "crypto";
import { query, withTransaction } from "../../../config/db";
import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { sendProfessionalEmail } from "../email";
import { draftEmail } from "../draft";
import { geminiGenerateContent, isGeminiLive } from "../../ai/geminiClient";
import { scheduleLeadMeeting } from "../../sales/calendar-sales.service";
import {
  syncPipelineToTrello,
  importDealsFromTrello,
  postPipelineDigestToSlack,
  salesConnectionsLine,
} from "./integrations";
import type { GeminiToolFunction } from "../../ai/geminiClient";
import type { AutomationProposal, PersonaVertical } from "../registry";
import { AppError } from "../../../utils/errors";
import { logger } from "../../../observability/logger";
import {
  createMailchimpCampaignDraft, getMailchimpCampaignInfo, getMailchimpCampaignReport,
  listMailchimpAudiences, refreshMailchimpCampaignDraft, scheduleMailchimpCampaign,
  sendMailchimpCampaign, unscheduleMailchimpCampaign,
  MailchimpDraftPartialError,
} from "../marketing/mailchimp.service";
import { canResolveAsProviderDraft } from "../marketing/campaign-state";
import { activationCampaignMatches } from "../marketing/activation.model";
import { compareMarketingGoal, suggestMarketingExperiments, type MarketingExperimentSuggestion, type MarketingGoalMetric, type MarketingGoalProgress } from "../marketing/campaign-goals.model";

const PERSONA = "sales";

// ─── Types ──────────────────────────────────────────────────────────────────
export type DealStage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost" | "nurture";
export type ContractStatus = "draft" | "sent" | "signed" | "declined";
export type MarketingLeadStatus = "new" | "qualified" | "following_up" | "nurture" | "converted" | "disqualified";

export interface SalesContact {
  id: string; name: string; email: string | null; company: string | null; title: string | null;
  phone: string | null; notes: string | null; territory: string | null; domain: string | null;
  industry: string | null; source: string; marketingOptIn: boolean; marketingCampaignId: string | null;
  marketingAttribution: Record<string, string>; marketingLeadStatus: MarketingLeadStatus;
  lastContactedAt: Date | null; createdAt: Date;
}
export interface SalesDeal {
  id: string; title: string; contactId: string | null; marketingCampaignId: string | null;
  contactName: string | null; company: string | null; amountCents: number;
  currency: string; stage: DealStage; closeDate: string | null; notes: string | null;
  ownerRep: string | null; lastActivityAt: Date | null; source: string; createdAt: Date;
}
export interface SalesActivity { id: string; dealId: string | null; kind: string; note: string | null; createdAt: Date }
export interface SalesRep { id: string; name: string; email: string | null; territory: string | null; createdAt: Date }
export interface SalesContract {
  id: string; dealId: string | null; title: string; body: string | null; amountCents: number;
  currency: string; status: ContractStatus; sentAt: Date | null; signedAt: Date | null; createdAt: Date;
}
export interface MarketingCampaign {
  id: string; topic: string; audience: string | null; subject: string; body: string;
  objective: string | null; offer: string | null; successMetric: string | null; channels: string[];
  goalMetric: MarketingGoalMetric | null; goalTarget: number | null; goalCurrency: string | null;
  startDate: Date | null; endDate: Date | null; budgetCents: number | null;
  status: "draft" | "provider_creating" | "provider_draft" | "provider_review" | "scheduling" | "scheduled" | "unscheduling" | "sending" | "sent" | "failed" | "send_review";
  recipientCount: number; sentCount: number; providerCampaignId: string | null; providerAudienceId: string | null;
  fromName: string | null; replyTo: string | null; scheduledAt: Date | null; providerMetrics: Record<string, number>;
  providerSyncedAt: Date | null; providerActionStartedAt: Date | null; createdAt: Date; updatedAt: Date; sentAt: Date | null;
}
export interface MarketingPerformanceCurrencyValue { currency: string; amountCents: number }
export interface MarketingPerformanceCampaign {
  id: string; topic: string; status: MarketingCampaign["status"]; startDate: Date | null; endDate: Date | null;
  goal: MarketingGoalProgress | null; experiments: MarketingExperimentSuggestion[];
  budgetCents: number | null; leads: number; qualifiedLeads: number; opportunities: number;
  closedWonDeals: number; pipelineByCurrency: MarketingPerformanceCurrencyValue[];
  closedWonByCurrency: MarketingPerformanceCurrencyValue[]; signedContractByCurrency: MarketingPerformanceCurrencyValue[];
  content: { draft: number; inReview: number; approved: number; planned: number; publishing: number; publishReview: number; published: number; completed: number };
  activations: { total: number; planned: number; inProgress: number; completed: number; cancelled: number; withOutcome: number; trackedRedirects: number; plannedCostByCurrency: MarketingPerformanceCurrencyValue[]; actualCostByCurrency: MarketingPerformanceCurrencyValue[]; results: { reach: number; engagements: number; leads: number; conversions: number } };
  email: { sent: number; uniqueOpens: number; uniqueClicks: number; unsubscribes: number; bounces: number; syncedAt: Date | null };
}
export interface MarketingPerformance {
  generatedAt: Date;
  campaigns: MarketingPerformanceCampaign[];
  totals: {
    campaignCount: number; attributedLeads: number; qualifiedLeads: number; opportunities: number; closedWonDeals: number;
    plannedBudgetCents: number; pipelineByCurrency: MarketingPerformanceCurrencyValue[];
    closedWonByCurrency: MarketingPerformanceCurrencyValue[]; signedContractByCurrency: MarketingPerformanceCurrencyValue[];
    activations: number; completedActivations: number; trackedActivationRedirects: number; actualActivationCostByCurrency: MarketingPerformanceCurrencyValue[];
    activationResults: { reach: number; engagements: number; leads: number; conversions: number };
  };
}
export interface MarketingConsentEvent { id: string; optedIn: boolean; source: string; evidence: string | null; createdAt: Date }
export interface MarketingLeadFormSettings {
  formKey: string;
  brandName: string;
  headline: string;
  description: string;
  accentColor: string;
  privacyPolicyUrl: string | null;
  marketingConsentText: string | null;
}
export interface DealDetail { deal: SalesDeal; contact: SalesContact | null; activities: SalesActivity[]; contracts: SalesContract[] }
export interface SalesOverview {
  briefing: string;
  pipelineValueCents: number;
  openCount: number;
  wonValueCents: number;
  stageBreakdown: { stage: DealStage; count: number; valueCents: number }[];
  atRisk: { id: string; title: string; company: string | null; amountCents: number; stage: DealStage }[];
  contractsOut: number;
}

const CONTACT_COLS =
  "id, name, email, company, title, phone, notes, territory, domain, industry, source, marketing_opt_in, marketing_campaign_id, marketing_attribution, marketing_lead_status, last_contacted_at, created_at";
const DEAL_COLS =
  "id, title, contact_id, marketing_campaign_id, contact_name, company, amount_cents, currency, stage, close_date, notes, owner_rep, last_activity_at, source, created_at";

const CAMPAIGN_COLS = "id, topic, audience, subject, body, objective, offer, success_metric, channels, goal_metric, goal_target, goal_currency, start_date, end_date, budget_cents, status, recipient_count, sent_count, provider_campaign_id, provider_audience_id, from_name, reply_to, scheduled_at, provider_metrics, provider_synced_at, provider_action_started_at, created_at, updated_at, sent_at";

function mapCampaign(r: {
  id: string; topic: string; audience: string | null; subject: string; body: string;
  objective: string | null; offer: string | null; success_metric: string | null; channels: string[];
  goal_metric: MarketingGoalMetric | null; goal_target: number | string | null; goal_currency: string | null;
  start_date: Date | null; end_date: Date | null; budget_cents: string | number | null;
  status: MarketingCampaign["status"]; recipient_count: number; sent_count: number;
  provider_campaign_id: string | null; provider_audience_id: string | null; from_name: string | null; reply_to: string | null;
  scheduled_at: Date | null; provider_metrics: Record<string, number>; provider_synced_at: Date | null;
  provider_action_started_at: Date | null;
  created_at: Date; updated_at: Date; sent_at: Date | null;
}): MarketingCampaign {
  return { id: r.id, topic: r.topic, audience: r.audience, subject: r.subject, body: r.body,
    objective: r.objective, offer: r.offer, successMetric: r.success_metric, channels: r.channels ?? ["email"],
    goalMetric: r.goal_metric, goalTarget: r.goal_target === null ? null : Number(r.goal_target), goalCurrency: r.goal_currency,
    startDate: r.start_date, endDate: r.end_date, budgetCents: r.budget_cents === null ? null : Number(r.budget_cents),
    status: r.status, recipientCount: r.recipient_count, sentCount: r.sent_count,
    providerCampaignId: r.provider_campaign_id, providerAudienceId: r.provider_audience_id,
    fromName: r.from_name, replyTo: r.reply_to, scheduledAt: r.scheduled_at,
    providerMetrics: r.provider_metrics ?? {}, providerSyncedAt: r.provider_synced_at,
    providerActionStartedAt: r.provider_action_started_at,
    createdAt: r.created_at, updatedAt: r.updated_at, sentAt: r.sent_at };
}

export async function listMarketingCampaigns(userId: string): Promise<MarketingCampaign[]> {
  const result = await query(`SELECT ${CAMPAIGN_COLS} FROM sales_marketing_campaigns WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => mapCampaign(row as never));
}

export interface MarketingCampaignBrief {
  topic: string; audience?: string; objective?: string; offer?: string; successMetric?: string;
  goalMetric?: MarketingGoalMetric; goalTarget?: number; goalCurrency?: string;
  channels?: string[]; startDate?: string; endDate?: string; budgetCents?: number;
}

export interface MarketingCampaignLeads {
  total: number;
  recent: { id: string; name: string; email: string | null; company: string | null; source: string; createdAt: Date; utmSource: string | null; utmMedium: string | null }[];
}
export async function getMarketingCampaignLeads(userId: string, campaignId: string): Promise<MarketingCampaignLeads> {
  const campaign = await query(`SELECT 1 FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`, [campaignId, userId]);
  if (!campaign.rows[0]) throw new AppError("Campaign not found.", 404);
  const [count, recent] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(DISTINCT contact_id)::text AS count FROM sales_marketing_contact_attributions WHERE user_id=$1 AND campaign_id=$2`, [userId, campaignId]),
    query(`SELECT id,name,email,company,source,captured_at AS created_at,utm_source,utm_medium FROM (
        SELECT DISTINCT ON (c.id) c.id,c.name,c.email,c.company,c.source,a.captured_at,
          a.attribution->>'utmSource' AS utm_source,a.attribution->>'utmMedium' AS utm_medium
        FROM sales_marketing_contact_attributions a JOIN sales_contacts c ON c.id=a.contact_id AND c.user_id=a.user_id
        WHERE a.user_id=$1 AND a.campaign_id=$2
        ORDER BY c.id,a.captured_at DESC
      ) AS unique_contacts ORDER BY captured_at DESC LIMIT 10`, [userId, campaignId]),
  ]);
  return {
    total: Number(count.rows[0]?.count ?? 0),
    recent: recent.rows.map((row) => ({ id: row.id, name: row.name, email: row.email, company: row.company, source: row.source, createdAt: row.created_at, utmSource: row.utm_source, utmMedium: row.utm_medium })),
  };
}

/** Aggregate only Interlink-owned facts. Provider email metrics remain provider-reported. */
export async function getMarketingPerformance(userId: string): Promise<MarketingPerformance> {
  const [campaignRows, leadRows, dealRows, contractRows, contentRows, activationRows] = await Promise.all([
    query(`SELECT ${CAMPAIGN_COLS} FROM sales_marketing_campaigns WHERE user_id=$1 ORDER BY created_at DESC`, [userId]),
    query(`SELECT a.campaign_id,GROUPING(a.campaign_id)::int AS total_row,COUNT(DISTINCT a.contact_id)::int AS leads,
        COUNT(DISTINCT a.contact_id) FILTER (WHERE c.marketing_lead_status IN ('qualified','following_up','converted'))::int AS qualified_leads
      FROM sales_marketing_contact_attributions a
      JOIN sales_contacts c ON c.id=a.contact_id AND c.user_id=a.user_id
      WHERE a.user_id=$1 AND a.campaign_id IS NOT NULL GROUP BY GROUPING SETS ((a.campaign_id),())`, [userId]),
    query(`SELECT marketing_campaign_id AS campaign_id,currency,COUNT(*)::int AS opportunities,
        COUNT(*) FILTER (WHERE stage='won')::int AS closed_won,
        SUM(amount_cents) FILTER (WHERE stage NOT IN ('won','lost'))::text AS pipeline_cents,
        SUM(amount_cents) FILTER (WHERE stage='won')::text AS closed_won_cents
      FROM sales_deals WHERE user_id=$1 AND marketing_campaign_id IS NOT NULL
      GROUP BY marketing_campaign_id,currency`, [userId]),
    query(`SELECT d.marketing_campaign_id AS campaign_id,sc.currency,COUNT(*)::int AS contracts,
        SUM(sc.amount_cents)::text AS signed_cents
      FROM sales_contracts sc JOIN sales_deals d ON d.id=sc.deal_id AND d.user_id=sc.user_id
      WHERE sc.user_id=$1 AND d.marketing_campaign_id IS NOT NULL AND sc.status='signed'
      GROUP BY d.marketing_campaign_id,sc.currency`, [userId]),
    query(`SELECT campaign_id,
        COUNT(*) FILTER (WHERE status='draft')::int AS draft,
        COUNT(*) FILTER (WHERE status='in_review')::int AS in_review,
        COUNT(*) FILTER (WHERE status='approved')::int AS approved,
        COUNT(*) FILTER (WHERE status='planned')::int AS planned,
        COUNT(*) FILTER (WHERE status='publishing')::int AS publishing,
        COUNT(*) FILTER (WHERE status='publish_review')::int AS publish_review,
        COUNT(*) FILTER (WHERE status='published')::int AS published,
        COUNT(*) FILTER (WHERE status='completed')::int AS completed
      FROM sales_marketing_content_items WHERE user_id=$1 AND campaign_id IS NOT NULL GROUP BY campaign_id`, [userId]),
    query(`SELECT a.campaign_id,a.status,a.planned_cost::text,a.actual_cost::text,a.currency,a.outcome,a.reach_count,a.engagement_count,a.lead_count,a.conversion_count,
        COALESCE((SELECT SUM(m.redirect_count) FROM sales_marketing_activation_link_metrics m
          WHERE m.user_id=a.user_id AND m.activation_id=a.id),0)::text AS tracked_redirects
      FROM sales_marketing_activations a WHERE a.user_id=$1 AND a.campaign_id IS NOT NULL`, [userId]),
  ]);

  const asAmount = (value: unknown): number => value === null || value === undefined ? 0 : Number(value);
  const amountRows = (rows: Array<Record<string, unknown>>, amountKey: string): MarketingPerformanceCurrencyValue[] =>
    rows.map((row) => ({ currency: String(row.currency), amountCents: asAmount(row[amountKey]) }))
      .filter((row) => row.amountCents !== 0).sort((a, b) => a.currency.localeCompare(b.currency));
  const mergeAmounts = (rows: MarketingPerformanceCurrencyValue[]): MarketingPerformanceCurrencyValue[] => {
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amountCents);
    return [...totals].map(([currency, amountCents]) => ({ currency, amountCents })).sort((a, b) => a.currency.localeCompare(b.currency));
  };
  const overallLeads = leadRows.rows.find((row) => Number(row.total_row) === 1);
  const leadsByCampaign = new Map(leadRows.rows.filter((row) => Number(row.total_row) === 0).map((row) => [row.campaign_id as string, row]));
  const dealsByCampaign = new Map<string, typeof dealRows.rows>();
  for (const row of dealRows.rows) {
    const rows = dealsByCampaign.get(row.campaign_id as string) ?? [];
    rows.push(row); dealsByCampaign.set(row.campaign_id as string, rows);
  }
  const contractsByCampaign = new Map<string, typeof contractRows.rows>();
  for (const row of contractRows.rows) {
    const rows = contractsByCampaign.get(row.campaign_id as string) ?? [];
    rows.push(row); contractsByCampaign.set(row.campaign_id as string, rows);
  }
  const contentByCampaign = new Map(contentRows.rows.map((row) => [row.campaign_id as string, row]));
  const activationsByCampaign = new Map<string, typeof activationRows.rows>();
  for (const row of activationRows.rows) {
    const rows = activationsByCampaign.get(row.campaign_id as string) ?? [];
    rows.push(row); activationsByCampaign.set(row.campaign_id as string, rows);
  }
  const activationAmounts = (rows: typeof activationRows.rows, key: "planned_cost" | "actual_cost"): MarketingPerformanceCurrencyValue[] => {
    const totals = new Map<string, number>();
    for (const row of rows) {
      const value = row[key] === null ? 0 : Number(row[key]);
      if (Number.isFinite(value) && value !== 0) {
        const currency = String(row.currency).trim();
        totals.set(currency, (totals.get(currency) ?? 0) + Math.round(value * 100));
      }
    }
    return [...totals].map(([currency, amountCents]) => ({ currency, amountCents })).sort((a, b) => a.currency.localeCompare(b.currency));
  };

  const campaigns = campaignRows.rows.map((raw) => {
    const campaign = mapCampaign(raw as never);
    const lead = leadsByCampaign.get(campaign.id);
    const deals = dealsByCampaign.get(campaign.id) ?? [];
    const contracts = contractsByCampaign.get(campaign.id) ?? [];
    const content = contentByCampaign.get(campaign.id);
    const activations = activationsByCampaign.get(campaign.id) ?? [];
    const metric = campaign.providerMetrics ?? {};
    const uniqueEmailClicks = campaign.providerSyncedAt && Number.isFinite(metric.uniqueClicks) ? Number(metric.uniqueClicks) : null;
    const emailUnsubscribes = campaign.providerSyncedAt && Number.isFinite(metric.unsubscribes) ? Number(metric.unsubscribes) : null;
    const hasReportedActivationOutcome = activations.some((row) =>
      Boolean(typeof row.outcome === "string" && row.outcome.trim())
      || Number(row.reach_count ?? 0) > 0 || Number(row.engagement_count ?? 0) > 0
      || Number(row.lead_count ?? 0) > 0 || Number(row.conversion_count ?? 0) > 0);
    const actualForGoal = campaign.goalMetric ? (() => {
      switch (campaign.goalMetric) {
        case "attributed_leads": return Number(lead?.leads ?? 0);
        case "qualified_leads": return Number(lead?.qualified_leads ?? 0);
        case "sales_opportunities": return deals.reduce((sum, row) => sum + Number(row.opportunities ?? 0), 0);
        case "closed_won_deals": return deals.reduce((sum, row) => sum + Number(row.closed_won ?? 0), 0);
        case "closed_won_value": return deals
          .filter((row) => String(row.currency).toUpperCase() === campaign.goalCurrency)
          .reduce((sum, row) => sum + Number(row.closed_won_cents ?? 0), 0);
        case "published_content": return Number(content?.published ?? 0);
        case "activation_reach": return hasReportedActivationOutcome ? activations.reduce((sum, row) => sum + Number(row.reach_count ?? 0), 0) : null;
        case "activation_engagements": return hasReportedActivationOutcome ? activations.reduce((sum, row) => sum + Number(row.engagement_count ?? 0), 0) : null;
        case "activation_leads": return hasReportedActivationOutcome ? activations.reduce((sum, row) => sum + Number(row.lead_count ?? 0), 0) : null;
        case "activation_conversions": return hasReportedActivationOutcome ? activations.reduce((sum, row) => sum + Number(row.conversion_count ?? 0), 0) : null;
        case "email_unique_opens": return campaign.providerSyncedAt && Number.isFinite(metric.uniqueOpens) ? Number(metric.uniqueOpens) : null;
        case "email_unique_clicks": return uniqueEmailClicks;
      }
    })() : null;
    const goal = campaign.goalMetric && campaign.goalTarget !== null
      ? compareMarketingGoal(campaign.goalMetric, campaign.goalTarget, campaign.goalCurrency, actualForGoal)
      : null;
    const experiments = suggestMarketingExperiments({
      leads: Number(lead?.leads ?? 0), qualifiedLeads: Number(lead?.qualified_leads ?? 0),
      opportunities: deals.reduce((sum, row) => sum + Number(row.opportunities ?? 0), 0),
      uniqueEmailClicks, unsubscribes: emailUnsubscribes,
      approvedContent: Number(content?.approved ?? 0), plannedContent: Number(content?.planned ?? 0),
      publishedContent: Number(content?.published ?? 0),
    });
    return {
      id: campaign.id, topic: campaign.topic, status: campaign.status, startDate: campaign.startDate, endDate: campaign.endDate,
      goal, experiments,
      budgetCents: campaign.budgetCents, leads: Number(lead?.leads ?? 0), qualifiedLeads: Number(lead?.qualified_leads ?? 0),
      opportunities: deals.reduce((sum, row) => sum + Number(row.opportunities ?? 0), 0),
      closedWonDeals: deals.reduce((sum, row) => sum + Number(row.closed_won ?? 0), 0),
      pipelineByCurrency: amountRows(deals as Array<Record<string, unknown>>, "pipeline_cents"),
      closedWonByCurrency: amountRows(deals as Array<Record<string, unknown>>, "closed_won_cents"),
      signedContractByCurrency: amountRows(contracts as Array<Record<string, unknown>>, "signed_cents"),
      content: { draft: Number(content?.draft ?? 0), inReview: Number(content?.in_review ?? 0), approved: Number(content?.approved ?? 0), planned: Number(content?.planned ?? 0), publishing: Number(content?.publishing ?? 0), publishReview: Number(content?.publish_review ?? 0), published: Number(content?.published ?? 0), completed: Number(content?.completed ?? 0) },
      activations: {
        total: activations.length,
        planned: activations.filter((row) => row.status === "planned").length,
        inProgress: activations.filter((row) => row.status === "in_progress").length,
        completed: activations.filter((row) => row.status === "completed").length,
        cancelled: activations.filter((row) => row.status === "cancelled").length,
        withOutcome: activations.filter((row) => typeof row.outcome === "string" && row.outcome.trim().length > 0).length,
        trackedRedirects: activations.reduce((sum, row) => sum + Number(row.tracked_redirects ?? 0), 0),
        plannedCostByCurrency: activationAmounts(activations, "planned_cost"),
        actualCostByCurrency: activationAmounts(activations, "actual_cost"),
        results: {
          reach: activations.reduce((sum, row) => sum + Number(row.reach_count ?? 0), 0),
          engagements: activations.reduce((sum, row) => sum + Number(row.engagement_count ?? 0), 0),
          leads: activations.reduce((sum, row) => sum + Number(row.lead_count ?? 0), 0),
          conversions: activations.reduce((sum, row) => sum + Number(row.conversion_count ?? 0), 0),
        },
      },
      email: {
        sent: Number(metric.emailsSent ?? campaign.sentCount), uniqueOpens: Number(metric.uniqueOpens ?? 0),
        uniqueClicks: Number(metric.uniqueClicks ?? 0), unsubscribes: Number(metric.unsubscribes ?? 0),
        bounces: Number(metric.bounces ?? 0), syncedAt: campaign.providerSyncedAt,
      },
    } satisfies MarketingPerformanceCampaign;
  });
  const totals = campaigns.reduce<MarketingPerformance["totals"]>((sum, row) => ({
    campaignCount: sum.campaignCount + 1, attributedLeads: sum.attributedLeads,
    qualifiedLeads: sum.qualifiedLeads, opportunities: sum.opportunities + row.opportunities,
    closedWonDeals: sum.closedWonDeals + row.closedWonDeals,
    plannedBudgetCents: sum.plannedBudgetCents + (row.budgetCents ?? 0),
    pipelineByCurrency: mergeAmounts([...sum.pipelineByCurrency, ...row.pipelineByCurrency]),
    closedWonByCurrency: mergeAmounts([...sum.closedWonByCurrency, ...row.closedWonByCurrency]),
    signedContractByCurrency: mergeAmounts([...sum.signedContractByCurrency, ...row.signedContractByCurrency]),
    activations: sum.activations + row.activations.total,
    completedActivations: sum.completedActivations + row.activations.completed,
    trackedActivationRedirects: sum.trackedActivationRedirects + row.activations.trackedRedirects,
    actualActivationCostByCurrency: mergeAmounts([...sum.actualActivationCostByCurrency, ...row.activations.actualCostByCurrency]),
    activationResults: {
      reach: sum.activationResults.reach + row.activations.results.reach,
      engagements: sum.activationResults.engagements + row.activations.results.engagements,
      leads: sum.activationResults.leads + row.activations.results.leads,
      conversions: sum.activationResults.conversions + row.activations.results.conversions,
    },
  }), { campaignCount: 0, attributedLeads: 0, qualifiedLeads: 0, opportunities: 0, closedWonDeals: 0, plannedBudgetCents: 0, pipelineByCurrency: [], closedWonByCurrency: [], signedContractByCurrency: [], activations: 0, completedActivations: 0, trackedActivationRedirects: 0, actualActivationCostByCurrency: [], activationResults: { reach: 0, engagements: 0, leads: 0, conversions: 0 } });
  totals.attributedLeads = Number(overallLeads?.leads ?? 0);
  totals.qualifiedLeads = Number(overallLeads?.qualified_leads ?? 0);
  return { generatedAt: new Date(), campaigns, totals };
}

export async function createMarketingCampaign(userId: string, brief: MarketingCampaignBrief): Promise<MarketingCampaign> {
  const { topic, audience } = brief;
  const copy = await draftEmail({ role: "marketing manager", purpose: "a concise marketing campaign email",
    context: `Topic: ${topic}. Objective: ${brief.objective ?? "not specified"}. Audience: ${audience?.trim() || "not specified"}. Offer: ${brief.offer ?? "not specified"}. Success measure: ${brief.successMetric ?? "not specified"}. Channels: ${(brief.channels ?? ["email"]).join(", ")}. Dates: ${brief.startDate ?? "unscheduled"} to ${brief.endDate ?? "unscheduled"}. Budget is a planning value only: ${brief.budgetCents === undefined ? "not specified" : `$${(brief.budgetCents / 100).toFixed(2)}`}. Create useful, truthful copy. Do not invent product claims or spend budget.` });
  return withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO sales_marketing_campaigns (user_id, topic, audience, subject, body, recipient_count, objective, offer, success_metric, channels, goal_metric, goal_target, goal_currency, start_date, end_date, budget_cents)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${CAMPAIGN_COLS}`,
      [userId, topic, audience?.trim() || null, copy.subject, copy.body, brief.objective?.trim() || null,
        brief.offer?.trim() || null, brief.successMetric?.trim() || null, brief.channels?.length ? brief.channels : ["email"],
        brief.goalMetric ?? null, brief.goalTarget ?? null, brief.goalCurrency ?? null,
        brief.startDate ?? null, brief.endDate ?? null, brief.budgetCents ?? null],
    );
    const campaign = result.rows[0];
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES($1,'campaign',$2,'created','Campaign brief created in Interlink.')`, [userId, campaign.id],
    );
    return mapCampaign(campaign as never);
  });
}

export async function updateMarketingCampaign(userId: string, id: string, patch: {
  subject?: string; body?: string; audience?: string | null;
  goalMetric?: MarketingGoalMetric | null; goalTarget?: number | null; goalCurrency?: string | null;
}): Promise<MarketingCampaign | null> {
  return withTransaction(async (client) => {
    const existing = await client.query(`SELECT status FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, userId]);
    if (!existing.rows[0]) return null;
    if (existing.rows[0].status !== "draft") throw new AppError("Only draft campaigns can be edited.", 409);
    const audience = patch.audience === undefined ? undefined : patch.audience?.trim() || null;
    const result = await client.query(
      `UPDATE sales_marketing_campaigns SET subject=COALESCE($3,subject), body=COALESCE($4,body),
         audience=CASE WHEN $5::boolean THEN $6 ELSE audience END,
         goal_metric=CASE WHEN $7::boolean THEN $8 ELSE goal_metric END,
         goal_target=CASE WHEN $7::boolean THEN $9 ELSE goal_target END,
         goal_currency=CASE WHEN $7::boolean THEN $10 ELSE goal_currency END,
         updated_at=now()
       WHERE id=$1 AND user_id=$2 AND status='draft' RETURNING ${CAMPAIGN_COLS}`,
      [id, userId, patch.subject ?? null, patch.body ?? null, patch.audience !== undefined, audience ?? null,
        patch.goalMetric !== undefined, patch.goalMetric ?? null, patch.goalTarget ?? null, patch.goalCurrency ?? null],
    );
    if (!result.rows[0]) return null;
    const fields = [patch.subject !== undefined ? "subject" : null, patch.body !== undefined ? "copy" : null,
      patch.audience !== undefined ? "audience" : null, patch.goalMetric !== undefined ? "goal target" : null].filter(Boolean);
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES($1,'campaign',$2,'edited',$3)`,
      [userId, id, `Updated ${fields.join(", ") || "campaign brief"}.`],
    );
    return mapCampaign(result.rows[0] as never);
  });
}

export async function sendMarketingCampaign(user: AppUser, id: string): Promise<{ campaign: MarketingCampaign; sent: number }> {
  const claim = await query(
    `UPDATE sales_marketing_campaigns SET status='sending', provider_action_started_at=now(), provider_synced_at=NULL, updated_at=now()
     WHERE id=$1 AND user_id=$2 AND status='provider_draft' AND provider_campaign_id IS NOT NULL RETURNING ${CAMPAIGN_COLS}`,
    [id, user.id],
  );
  if (!claim.rows[0]) throw new AppError("Create and review the Mailchimp draft before sending it.", 409);
  const campaign = mapCampaign(claim.rows[0] as never);
  try {
    await sendMailchimpCampaign(user.id, campaign.providerCampaignId!);
  } catch (error) {
    const status = error instanceof AppError && error.statusCode < 500 ? "provider_draft" : "send_review";
    await query(`UPDATE sales_marketing_campaigns SET status=$3,
      provider_action_started_at=CASE WHEN $3='provider_draft' THEN NULL ELSE provider_action_started_at END,
      provider_synced_at=CASE WHEN $3='provider_draft' THEN now() ELSE provider_synced_at END,
      updated_at=now() WHERE id=$1 AND user_id=$2`, [id, user.id, status]);
    throw error;
  }
  const updated = await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE sales_marketing_campaigns SET status='sending', updated_at=now()
       WHERE id=$1 AND user_id=$2 RETURNING ${CAMPAIGN_COLS}`,
      [id, user.id],
    );
    if (!result.rows[0]) throw new AppError("Campaign disappeared after the provider action.", 409);
    await client.query(
      `INSERT INTO sales_marketing_approval_events (user_id,entity_type,entity_id,action,note)
       VALUES ($1,'campaign',$2,'approved','User confirmed immediate delivery in Interlink.')`, [user.id, id],
    );
    return result.rows[0];
  });
  return { campaign: mapCampaign(updated as never), sent: 0 };
}

export async function getMarketingProviderAudiences(userId: string) { return listMailchimpAudiences(userId); }

export async function createMarketingProviderDraft(userId: string, id: string, input: { audienceId: string; fromName: string; replyTo: string }): Promise<MarketingCampaign> {
  const claim = await query(
    `UPDATE sales_marketing_campaigns SET status='provider_creating', provider_audience_id=$3,
       from_name=$4, reply_to=$5, provider_action_started_at=now(), provider_synced_at=NULL, updated_at=now()
     WHERE id=$1 AND user_id=$2 AND status='draft' RETURNING ${CAMPAIGN_COLS}`,
    [id, userId, input.audienceId, input.fromName, input.replyTo],
  );
  if (!claim.rows[0]) throw new AppError("This campaign is not an editable draft.", 409);
  const campaign = mapCampaign(claim.rows[0] as never);
  try {
    const provider = await createMailchimpCampaignDraft(userId, {
      campaignId: campaign.id, topic: campaign.topic, subject: campaign.subject, body: campaign.body,
      audienceId: input.audienceId, fromName: input.fromName, replyTo: input.replyTo,
    });
    return withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE sales_marketing_campaigns SET status='provider_draft', provider_campaign_id=$3,
           recipient_count=$4, provider_synced_at=now(), provider_action_started_at=NULL, updated_at=now()
         WHERE id=$1 AND user_id=$2 RETURNING ${CAMPAIGN_COLS}`,
        [id, userId, provider.id, provider.recipientCount],
      );
      if (!result.rows[0]) throw new AppError("Campaign disappeared after the provider draft was created.", 409);
      await client.query(
        `INSERT INTO sales_marketing_approval_events (user_id,entity_type,entity_id,action,note)
         VALUES ($1,'campaign',$2,'submitted','Mailchimp draft created; sending still requires separate confirmation.')`, [userId, id],
      );
      return mapCampaign(result.rows[0] as never);
    });
  } catch (error) {
    if (error instanceof MailchimpDraftPartialError) {
      await query(`UPDATE sales_marketing_campaigns SET status='provider_review', provider_campaign_id=$3,
        provider_synced_at=now(), provider_action_started_at=NULL, updated_at=now()
        WHERE id=$1 AND user_id=$2`, [id, userId, error.providerCampaignId]);
    } else {
      const status = error instanceof AppError && error.statusCode < 500 ? "draft" : "provider_review";
      await query(`UPDATE sales_marketing_campaigns SET status=$3,
        provider_action_started_at=CASE WHEN $3='draft' THEN NULL ELSE provider_action_started_at END,
        provider_synced_at=CASE WHEN $3='draft' THEN now() ELSE provider_synced_at END,
        updated_at=now() WHERE id=$1 AND user_id=$2`, [id, userId, status]);
    }
    throw error;
  }
}

export async function reconcileMarketingProviderDraft(userId: string, id: string, providerCampaignId: string): Promise<MarketingCampaign> {
  const current = await query(`SELECT provider_campaign_id, provider_audience_id, status, provider_action_started_at FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`, [id, userId]);
  const row = current.rows[0];
  if (!row) throw new AppError("Campaign not found.", 404);
  const staleCreate = row.status === "provider_creating" && row.provider_action_started_at instanceof Date &&
    row.provider_action_started_at.getTime() < Date.now() - 2 * 60_000;
  if (!(row.status === "provider_review" || staleCreate) || row.provider_campaign_id) throw new AppError("This campaign is not waiting for Mailchimp draft recovery. If draft creation just started, wait two minutes and sync again.", 409);
  if (!row.provider_audience_id) throw new AppError("The Mailchimp audience could not be verified for recovery.", 409);
  const provider = await getMailchimpCampaignInfo(userId, providerCampaignId);
  if (provider.title !== `Interlink ${id}` || provider.audienceId !== row.provider_audience_id) {
    throw new AppError("That Mailchimp campaign does not match this Interlink campaign and audience.", 422);
  }
  if (provider.status !== "save") throw new AppError("Only an unsent Mailchimp draft can be recovered into Interlink.", 409);
  const linked = await query(`UPDATE sales_marketing_campaigns SET provider_campaign_id=$3, provider_synced_at=NULL,
    provider_action_started_at=NULL, status='provider_review', updated_at=now()
    WHERE id=$1 AND user_id=$2 AND status IN ('provider_review','provider_creating') AND provider_campaign_id IS NULL RETURNING id`, [id, userId, providerCampaignId]);
  if (!linked.rows[0]) throw new AppError("This campaign recovery was already completed. Refresh and sync its status.", 409);
  return syncMarketingCampaign(userId, id);
}

export async function scheduleMarketingCampaign(userId: string, id: string, scheduledAt: Date): Promise<MarketingCampaign> {
  if (scheduledAt.getTime() < Date.now() + 15 * 60_000) throw new AppError("Choose a send time at least 15 minutes from now.", 400);
  const claim = await query(`UPDATE sales_marketing_campaigns SET status='scheduling', provider_action_started_at=now(), provider_synced_at=NULL, updated_at=now() WHERE id=$1 AND user_id=$2 AND status='provider_draft' AND provider_campaign_id IS NOT NULL RETURNING provider_campaign_id`, [id, userId]);
  const providerCampaignId = claim.rows[0]?.provider_campaign_id as string | undefined;
  if (!providerCampaignId) throw new AppError("Only a Mailchimp draft can be scheduled.", 409);
  try { await scheduleMailchimpCampaign(userId, providerCampaignId, scheduledAt); }
  catch (error) {
    const status = error instanceof AppError && error.statusCode < 500 ? "provider_draft" : "send_review";
    await query(`UPDATE sales_marketing_campaigns SET status=$3,
      provider_action_started_at=CASE WHEN $3='provider_draft' THEN NULL ELSE provider_action_started_at END,
      provider_synced_at=CASE WHEN $3='provider_draft' THEN now() ELSE provider_synced_at END,
      updated_at=now() WHERE id=$1 AND user_id=$2`, [id, userId, status]);
    throw error;
  }
  return withTransaction(async (client) => {
    const result = await client.query(`UPDATE sales_marketing_campaigns SET status='scheduled', scheduled_at=$3, provider_action_started_at=NULL, provider_synced_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING ${CAMPAIGN_COLS}`, [id, userId, scheduledAt]);
    if (!result.rows[0]) throw new AppError("Campaign disappeared after scheduling.", 409);
    await client.query(`INSERT INTO sales_marketing_approval_events (user_id, entity_type, entity_id, action) VALUES ($1,'campaign',$2,'scheduled')`, [userId, id]);
    return mapCampaign(result.rows[0] as never);
  });
}

export async function unscheduleMarketingCampaign(userId: string, id: string): Promise<MarketingCampaign> {
  const claim = await query(`UPDATE sales_marketing_campaigns SET status='unscheduling', provider_action_started_at=now(), provider_synced_at=NULL, updated_at=now() WHERE id=$1 AND user_id=$2 AND status='scheduled' AND provider_campaign_id IS NOT NULL RETURNING provider_campaign_id`, [id, userId]);
  const providerCampaignId = claim.rows[0]?.provider_campaign_id as string | undefined;
  if (!providerCampaignId) throw new AppError("This campaign is not scheduled.", 409);
  try { await unscheduleMailchimpCampaign(userId, providerCampaignId); }
  catch (error) {
    const status = error instanceof AppError && error.statusCode < 500 ? "scheduled" : "send_review";
    await query(`UPDATE sales_marketing_campaigns SET status=$3,
      provider_action_started_at=CASE WHEN $3='scheduled' THEN NULL ELSE provider_action_started_at END,
      provider_synced_at=CASE WHEN $3='scheduled' THEN now() ELSE provider_synced_at END,
      updated_at=now() WHERE id=$1 AND user_id=$2`, [id, userId, status]);
    throw error;
  }
  return withTransaction(async (client) => {
    const result = await client.query(`UPDATE sales_marketing_campaigns SET status='provider_draft', scheduled_at=NULL, provider_action_started_at=NULL, provider_synced_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING ${CAMPAIGN_COLS}`, [id, userId]);
    if (!result.rows[0]) throw new AppError("Campaign disappeared after it was unscheduled.", 409);
    await client.query(`INSERT INTO sales_marketing_approval_events (user_id, entity_type, entity_id, action) VALUES ($1,'campaign',$2,'cancelled')`, [userId, id]);
    return mapCampaign(result.rows[0] as never);
  });
}

export async function syncMarketingCampaign(userId: string, id: string): Promise<MarketingCampaign> {
  const current = await query(`SELECT ${CAMPAIGN_COLS} FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!current.rows[0]) throw new AppError("Campaign not found.", 404);
  const row = mapCampaign(current.rows[0] as never);
  if (!row.providerCampaignId) throw new AppError("This campaign has no linked Mailchimp campaign yet. Search Mailchimp for the Interlink campaign title before retrying provider setup.", 409);
  const provider = await getMailchimpCampaignInfo(userId, row.providerCampaignId);
  if (provider.status === "sent") {
    const report = await getMailchimpCampaignReport(userId, row.providerCampaignId);
    const wasSent = row.status !== "sent";
    await withTransaction(async (client) => {
      await client.query(`UPDATE sales_marketing_campaigns SET status='sent', sent_count=$3, sent_at=COALESCE(sent_at,now()), provider_metrics=$4::jsonb, provider_synced_at=now(), provider_action_started_at=NULL, updated_at=now() WHERE id=$1 AND user_id=$2`, [id, userId, report.emailsSent, JSON.stringify(report)]);
      if (wasSent) {
        await client.query(`INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note) VALUES ($1,'campaign',$2,'sent','Mailchimp reported delivery complete.')`, [userId, id]);
      }
    });
    if (wasSent) {
      await recordActivity({ userId, persona: PERSONA, kind: "campaign_sent", title: "Campaign sent through Mailchimp", detail: `${report.emailsSent} emails reported sent.`, entityType: "marketing_campaign", entityId: id });
    }
  } else if (provider.status === "schedule") {
    await withTransaction(async (client) => {
      await client.query(`UPDATE sales_marketing_campaigns SET status='scheduled', scheduled_at=COALESCE($3,scheduled_at), provider_synced_at=now(), provider_action_started_at=NULL, updated_at=now() WHERE id=$1 AND user_id=$2`, [id, userId, provider.scheduledAt]);
      if (row.status !== "scheduled") {
        await client.query(`INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note) VALUES($1,'campaign',$2,'scheduled','Mailchimp confirmed the scheduled campaign during sync.')`, [userId, id]);
      }
    });
  } else if (provider.status === "save") {
    if (row.status === "provider_review") {
      await refreshMailchimpCampaignDraft(userId, { providerCampaignId: row.providerCampaignId, subject: row.subject, body: row.body, fromName: row.fromName ?? "", replyTo: row.replyTo ?? "" });
    }
    const releaseToDraft = canResolveAsProviderDraft({
      status: row.status, providerActionStartedAt: row.providerActionStartedAt,
      providerSyncedAt: row.providerSyncedAt,
    });
    if (releaseToDraft) {
      await withTransaction(async (client) => {
        await client.query(`UPDATE sales_marketing_campaigns SET status='provider_draft',
          provider_action_started_at=NULL, provider_synced_at=now(), updated_at=now()
          WHERE id=$1 AND user_id=$2`, [id, userId]);
        await client.query(`INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note) VALUES($1,'campaign',$2,'reconciled','Provider sync confirmed an unsent draft and released the action hold.')`, [userId, id]);
      });
    } else {
      await query(`UPDATE sales_marketing_campaigns SET provider_synced_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2`, [id, userId]);
    }
  } else {
    await query(`UPDATE sales_marketing_campaigns SET provider_synced_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2`, [id, userId]);
  }
  const result = await query(`SELECT ${CAMPAIGN_COLS} FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`, [id, userId]);
  return mapCampaign(result.rows[0] as never);
}

// ─── Contacts ────────────────────────────────────────────────────────────────
export async function listContacts(userId: string): Promise<SalesContact[]> {
  const res = await query(`SELECT ${CONTACT_COLS} FROM sales_contacts WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(mapContact as never);
}
export async function getContact(userId: string, id: string): Promise<SalesContact | null> {
  const res = await query(`SELECT ${CONTACT_COLS} FROM sales_contacts WHERE id = $1 AND user_id = $2`, [id, userId]);
  return res.rows[0] ? mapContact(res.rows[0] as never) : null;
}
async function findContactByName(userId: string, name: string): Promise<SalesContact | null> {
  const all = await listContacts(userId);
  const n = name.trim().toLowerCase();
  return all.find((c) => c.name.toLowerCase() === n) ?? all.find((c) => c.name.toLowerCase().includes(n)) ?? null;
}
export async function createContact(
  userId: string,
  data: { name: string; email?: string; company?: string; title?: string; phone?: string; notes?: string; territory?: string; domain?: string; industry?: string; source?: string; marketingOptIn?: boolean; marketingCampaignId?: string; marketingAttribution?: Record<string, string> },
): Promise<SalesContact> {
  const res = await query(
    `WITH inserted AS (
       INSERT INTO sales_contacts (user_id, name, email, company, title, phone, notes, territory, domain, industry, source, marketing_opt_in, marketing_campaign_id, marketing_attribution)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING ${CONTACT_COLS}
     ), logged AS (
       INSERT INTO sales_marketing_consent_events (user_id,contact_id,opted_in,source,evidence)
       SELECT $1,id,true,'user_recorded','Set when this contact was created in Interlink'
       FROM inserted WHERE marketing_opt_in=true RETURNING id
     )
     SELECT inserted.* FROM inserted LEFT JOIN logged ON true`,
    [userId, data.name, data.email ?? null, data.company ?? null, data.title ?? null, data.phone ?? null, data.notes ?? null, data.territory ?? null, data.domain ?? null, data.industry ?? null, data.source ?? "manual", data.marketingOptIn ?? false, data.marketingCampaignId ?? null, JSON.stringify(data.marketingAttribution ?? {})],
  );
  return mapContact(res.rows[0] as never);
}
export async function updateContact(
  userId: string, id: string,
  patch: { email?: string; company?: string; title?: string; territory?: string; domain?: string; industry?: string;
    marketingOptIn?: boolean; marketingOptInSource?: string; marketingOptInEvidence?: string },
): Promise<SalesContact | null> {
  const res = await query(
    `WITH previous AS (
       SELECT marketing_opt_in FROM sales_contacts WHERE id=$1 AND user_id=$2
     ), updated AS (
       UPDATE sales_contacts SET
         email=COALESCE($3,email), company=COALESCE($4,company), title=COALESCE($5,title),
         territory=COALESCE($6,territory), domain=COALESCE($7,domain), industry=COALESCE($8,industry),
         marketing_opt_in=COALESCE($9,marketing_opt_in), updated_at=now()
       WHERE id=$1 AND user_id=$2 RETURNING ${CONTACT_COLS}
     ), logged AS (
       INSERT INTO sales_marketing_consent_events (user_id,contact_id,opted_in,source,evidence)
       SELECT $2, updated.id, updated.marketing_opt_in,
         COALESCE(NULLIF($10::text,''),'user_recorded'),
         COALESCE(NULLIF($11::text,''),CASE WHEN updated.marketing_opt_in THEN 'Permission marked in Interlink Contacts workspace' ELSE 'Permission withdrawal recorded in Interlink Contacts workspace' END)
       FROM updated CROSS JOIN previous
       WHERE $9::boolean IS NOT NULL AND (previous.marketing_opt_in IS DISTINCT FROM updated.marketing_opt_in OR $10::text IS NOT NULL OR $11::text IS NOT NULL)
       RETURNING id
     )
     SELECT updated.* FROM updated LEFT JOIN logged ON true`,
    [id, userId, patch.email ?? null, patch.company ?? null, patch.title ?? null, patch.territory ?? null, patch.domain ?? null, patch.industry ?? null,
      patch.marketingOptIn ?? null, patch.marketingOptInSource ?? null, patch.marketingOptInEvidence?.trim() || null],
  );
  return res.rows[0] ? mapContact(res.rows[0] as never) : null;
}

export async function listMarketingConsentEvents(userId: string, contactId: string): Promise<MarketingConsentEvent[]> {
  const contact = await query(`SELECT 1 FROM sales_contacts WHERE id=$1 AND user_id=$2`, [contactId, userId]);
  if (!contact.rows[0]) throw new AppError("Contact not found.", 404);
  const result = await query(
    `SELECT id,opted_in,source,evidence,created_at FROM sales_marketing_consent_events
      WHERE user_id=$1 AND contact_id=$2 ORDER BY created_at DESC LIMIT 20`, [userId, contactId],
  );
  return result.rows.map((row) => ({
    id: row.id as string, optedIn: row.opted_in as boolean, source: row.source as string,
    evidence: row.evidence as string | null, createdAt: row.created_at as Date,
  }));
}

// ─── Deals ───────────────────────────────────────────────────────────────────
export async function listDeals(userId: string): Promise<SalesDeal[]> {
  const res = await query(`SELECT ${DEAL_COLS} FROM sales_deals WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(mapDeal as never);
}
export async function getDeal(userId: string, id: string): Promise<SalesDeal | null> {
  const res = await query(`SELECT ${DEAL_COLS} FROM sales_deals WHERE id = $1 AND user_id = $2`, [id, userId]);
  return res.rows[0] ? mapDeal(res.rows[0] as never) : null;
}
async function getDealContact(userId: string, deal: SalesDeal): Promise<SalesContact | null> {
  if (deal.contactId) return getContact(userId, deal.contactId);
  return deal.contactName ? findContactByName(userId, deal.contactName) : null;
}
async function findDealByTitle(userId: string, title: string): Promise<SalesDeal | null> {
  const all = await listDeals(userId);
  const t = title.trim().toLowerCase();
  return all.find((d) => d.title.toLowerCase() === t) ?? all.find((d) => d.title.toLowerCase().includes(t)) ?? null;
}
export async function createDeal(
  userId: string,
  data: { title: string; contactName?: string; company?: string; amountCents?: number; currency?: string; stage?: DealStage; closeDate?: string; notes?: string; source?: string },
): Promise<SalesDeal> {
  const res = await query(
    `INSERT INTO sales_deals (user_id, title, contact_name, company, amount_cents, currency, stage, close_date, notes, source, last_activity_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING ${DEAL_COLS}`,
    [userId, data.title, data.contactName ?? null, data.company ?? null, data.amountCents ?? 0, data.currency ?? "USD", data.stage ?? "lead", data.closeDate ?? null, data.notes ?? null, data.source ?? "manual"],
  );
  return mapDeal(res.rows[0] as never);
}
/** Create a qualified sales opportunity from a reviewed Interlink marketing lead. */
export async function createMarketingOpportunity(userId: string, data: {
  contactId: string; campaignId?: string; title: string; amountCents?: number; currency?: string;
  closeDate?: string; notes?: string;
}): Promise<SalesDeal> {
  return withTransaction(async (client) => {
    const contactResult = await client.query(
      `SELECT c.id,c.name,c.company,c.marketing_campaign_id,
          (SELECT a.campaign_id FROM sales_marketing_contact_attributions a
            WHERE a.user_id=c.user_id AND a.contact_id=c.id ORDER BY a.captured_at DESC LIMIT 1) AS latest_campaign_id
         FROM sales_contacts c WHERE c.id=$1 AND c.user_id=$2 AND c.marketing_lead_status <> 'disqualified' FOR UPDATE`,
      [data.contactId, userId],
    );
    const contact = contactResult.rows[0];
    if (!contact) throw new AppError("Marketing lead not found or is disqualified.", 404);

    const campaignId = data.campaignId ?? contact.latest_campaign_id ?? contact.marketing_campaign_id ?? null;
    let campaignTopic: string | null = null;
    if (campaignId) {
      const campaignResult = await client.query(`SELECT topic FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`, [campaignId, userId]);
      if (!campaignResult.rows[0]) throw new AppError("The selected campaign is not available in this workspace.", 404);
      campaignTopic = campaignResult.rows[0].topic as string;
    }
    const inserted = await client.query(
      `INSERT INTO sales_deals (user_id,title,contact_id,marketing_campaign_id,contact_name,company,amount_cents,currency,stage,close_date,notes,source,last_activity_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'qualified',$9,$10,'marketing',now()) RETURNING ${DEAL_COLS}`,
      [userId, data.title.trim(), contact.id, campaignId, contact.name, contact.company, data.amountCents ?? 0, data.currency ?? "USD", data.closeDate ?? null, data.notes?.trim() || null],
    );
    await client.query(
      `UPDATE sales_contacts SET marketing_lead_status=CASE WHEN marketing_lead_status='new' THEN 'qualified' ELSE marketing_lead_status END,updated_at=now() WHERE id=$1 AND user_id=$2`,
      [contact.id, userId],
    );
    await client.query(
      `INSERT INTO sales_activities(user_id,deal_id,contact_id,kind,note) VALUES($1,$2,$3,'marketing_opportunity_created',$4)`,
      [userId, inserted.rows[0].id, contact.id, campaignTopic ? `Created from a reviewed marketing lead; attributed to “${campaignTopic}”.` : "Created from a reviewed marketing lead without campaign attribution."],
    );
    return mapDeal(inserted.rows[0] as never);
  });
}
export async function updateDeal(
  userId: string, id: string,
  patch: { stage?: DealStage; amountCents?: number; notes?: string; ownerRep?: string; contactName?: string },
): Promise<SalesDeal | null> {
  return withTransaction(async (client) => {
    const res = await client.query(
      `UPDATE sales_deals SET
         stage=COALESCE($3,stage), amount_cents=COALESCE($4,amount_cents), notes=COALESCE($5,notes),
         owner_rep=COALESCE($6,owner_rep), contact_name=COALESCE($7,contact_name), last_activity_at=now(), updated_at=now()
       WHERE id=$1 AND user_id=$2 RETURNING ${DEAL_COLS}`,
      [id, userId, patch.stage ?? null, patch.amountCents ?? null, patch.notes ?? null, patch.ownerRep ?? null, patch.contactName ?? null],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (patch.stage === "won" && row.contact_id) {
      await client.query(`UPDATE sales_contacts SET marketing_lead_status='converted',updated_at=now() WHERE id=$1 AND user_id=$2`, [row.contact_id, userId]);
    }
    return mapDeal(row as never);
  });
}

// ─── Activities ────────────────────────────────────────────────────────────────
export async function logActivity(userId: string, data: { dealId?: string; contactId?: string; kind: string; note?: string }): Promise<void> {
  await query(
    `INSERT INTO sales_activities (user_id, deal_id, contact_id, kind, note) VALUES ($1,$2,$3,$4,$5)`,
    [userId, data.dealId ?? null, data.contactId ?? null, data.kind, data.note ?? null],
  );
  if (data.dealId) await query(`UPDATE sales_deals SET last_activity_at = now() WHERE id = $1 AND user_id = $2`, [data.dealId, userId]);
}
export async function listActivitiesForDeal(userId: string, dealId: string): Promise<SalesActivity[]> {
  const res = await query<{ id: string; deal_id: string | null; kind: string; note: string | null; created_at: Date }>(
    `SELECT id, deal_id, kind, note, created_at FROM sales_activities WHERE user_id=$1 AND deal_id=$2 ORDER BY created_at DESC`,
    [userId, dealId],
  );
  return res.rows.map((r) => ({ id: r.id, dealId: r.deal_id, kind: r.kind, note: r.note, createdAt: r.created_at }));
}

// ─── Reps ────────────────────────────────────────────────────────────────────
export async function listReps(userId: string): Promise<SalesRep[]> {
  const res = await query<{ id: string; name: string; email: string | null; territory: string | null; created_at: Date }>(
    `SELECT id, name, email, territory, created_at FROM sales_reps WHERE user_id=$1 ORDER BY created_at`, [userId]);
  return res.rows.map((r) => ({ id: r.id, name: r.name, email: r.email, territory: r.territory, createdAt: r.created_at }));
}
export async function createRep(userId: string, data: { name: string; email?: string; territory?: string }): Promise<SalesRep> {
  const res = await query<{ id: string; name: string; email: string | null; territory: string | null; created_at: Date }>(
    `INSERT INTO sales_reps (user_id, name, email, territory) VALUES ($1,$2,$3,$4) RETURNING id, name, email, territory, created_at`,
    [userId, data.name, data.email ?? null, data.territory ?? null]);
  const r = res.rows[0];
  return { id: r.id, name: r.name, email: r.email, territory: r.territory, createdAt: r.created_at };
}

// ─── Contracts ───────────────────────────────────────────────────────────────
const CONTRACT_COLS = "id, deal_id, title, body, amount_cents, currency, status, sent_at, signed_at, created_at";
export async function listContracts(userId: string): Promise<SalesContract[]> {
  const res = await query(`SELECT ${CONTRACT_COLS} FROM sales_contracts WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(mapContract2 as never);
}
export async function listContractsForDeal(userId: string, dealId: string): Promise<SalesContract[]> {
  const res = await query(`SELECT ${CONTRACT_COLS} FROM sales_contracts WHERE user_id=$1 AND deal_id=$2 ORDER BY created_at DESC`, [userId, dealId]);
  return res.rows.map(mapContract2 as never);
}
async function insertContract(userId: string, data: { dealId: string; title: string; body: string; amountCents: number; currency?: string }): Promise<SalesContract> {
  const res = await query(
    `INSERT INTO sales_contracts (user_id, deal_id, title, body, amount_cents, currency, status, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,'sent', now()) RETURNING ${CONTRACT_COLS}`,
    [userId, data.dealId, data.title, data.body, data.amountCents, data.currency ?? "USD"]);
  return mapContract2(res.rows[0] as never);
}

// ─── Detail + overview ───────────────────────────────────────────────────────
export async function getDealDetail(userId: string, dealId: string): Promise<DealDetail | null> {
  const deal = await getDeal(userId, dealId);
  if (!deal) return null;
  const [activities, contracts] = await Promise.all([listActivitiesForDeal(userId, dealId), listContractsForDeal(userId, dealId)]);
  const contact = await getDealContact(userId, deal);
  return { deal, contact, activities, contracts };
}

export async function getOverview(userId: string): Promise<SalesOverview> {
  const [deals, contracts] = await Promise.all([listDeals(userId), listContracts(userId)]);
  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const won = deals.filter((d) => d.stage === "won");
  const stages: DealStage[] = ["lead", "qualified", "proposal", "negotiation", "won", "lost", "nurture"];
  const stageBreakdown = stages
    .map((stage) => {
      const inStage = deals.filter((d) => d.stage === stage);
      return { stage, count: inStage.length, valueCents: inStage.reduce((s, d) => s + d.amountCents, 0) };
    })
    .filter((s) => s.count > 0);
  const cutoff = Date.now() - 14 * 86_400_000;
  const atRisk = open
    .filter((d) => (d.lastActivityAt ? new Date(d.lastActivityAt).getTime() : new Date(d.createdAt).getTime()) < cutoff)
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 5)
    .map((d) => ({ id: d.id, title: d.title, company: d.company, amountCents: d.amountCents, stage: d.stage }));
  const pipelineValueCents = open.reduce((s, d) => s + d.amountCents, 0);
  const fmt = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
  return {
    briefing: `${open.length} open deal(s) worth ${fmt(pipelineValueCents)}; ${atRisk.length} need attention.`,
    pipelineValueCents,
    openCount: open.length,
    wonValueCents: won.reduce((s, d) => s + d.amountCents, 0),
    stageBreakdown,
    atRisk,
    contractsOut: contracts.filter((c) => c.status === "sent").length,
  };
}

// ─── Inbound form key ──────────────────────────────────────────────────────────
export async function getOrCreateFormKey(userId: string): Promise<string> {
  const existing = await query<{ form_key: string }>(`SELECT form_key FROM sales_settings WHERE user_id=$1`, [userId]);
  if (existing.rows[0]) return existing.rows[0].form_key;
  const key = randomUUID().replace(/-/g, "").slice(0, 18);
  await query(`INSERT INTO sales_settings (user_id, form_key) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`, [userId, key]);
  const res = await query<{ form_key: string }>(`SELECT form_key FROM sales_settings WHERE user_id=$1`, [userId]);
  return res.rows[0].form_key;
}

function mapMarketingLeadFormSettings(row: Record<string, unknown>): MarketingLeadFormSettings {
  return {
    formKey: row.form_key as string,
    brandName: row.form_brand_name as string,
    headline: row.form_headline as string,
    description: row.form_description as string,
    accentColor: row.form_accent_color as string,
    privacyPolicyUrl: row.form_privacy_policy_url as string | null,
    marketingConsentText: row.form_marketing_consent as string | null,
  };
}

const MARKETING_FORM_SETTINGS_COLUMNS = `form_key,form_brand_name,form_headline,form_description,form_accent_color,form_privacy_policy_url,form_marketing_consent`;

export async function getMarketingLeadFormSettings(userId: string): Promise<MarketingLeadFormSettings> {
  await getOrCreateFormKey(userId);
  const result = await query(
    `SELECT ${MARKETING_FORM_SETTINGS_COLUMNS} FROM sales_settings WHERE user_id=$1`, [userId],
  );
  return mapMarketingLeadFormSettings(result.rows[0] as Record<string, unknown>);
}

export async function saveMarketingLeadFormSettings(userId: string, input: Omit<MarketingLeadFormSettings, "formKey">): Promise<MarketingLeadFormSettings> {
  await getOrCreateFormKey(userId);
  const result = await query(
    `UPDATE sales_settings
        SET form_brand_name=$2,form_headline=$3,form_description=$4,form_accent_color=$5,
            form_privacy_policy_url=$6,form_marketing_consent=$7
      WHERE user_id=$1 RETURNING ${MARKETING_FORM_SETTINGS_COLUMNS}`,
    [userId, input.brandName.trim(), input.headline.trim(), input.description.trim(), input.accentColor,
      input.privacyPolicyUrl, input.marketingConsentText?.trim() || null],
  );
  return mapMarketingLeadFormSettings(result.rows[0] as Record<string, unknown>);
}

export async function getMarketingLeadFormSettingsByKey(formKey: string): Promise<MarketingLeadFormSettings | null> {
  const result = await query(
    `SELECT ${MARKETING_FORM_SETTINGS_COLUMNS} FROM sales_settings WHERE form_key=$1`, [formKey],
  );
  return result.rows[0] ? mapMarketingLeadFormSettings(result.rows[0] as Record<string, unknown>) : null;
}

export async function captureInboundLead(formKey: string, data: {
  name: string; email?: string; company?: string; message?: string; campaignId?: string; activationId?: string;
  utmSource?: string; utmMedium?: string; utmCampaign?: string; utmContent?: string; landingPage?: string; referrer?: string;
  marketingOptIn?: boolean; marketingConsentText?: string;
}): Promise<{ ok: boolean }> {
  if (data.marketingOptIn && !data.email?.trim()) {
    throw new AppError("Enter an email address to give marketing email permission.", 400);
  }
  const marketingAttribution = Object.fromEntries(Object.entries({
    utmSource: data.utmSource, utmMedium: data.utmMedium, utmCampaign: data.utmCampaign,
    utmContent: data.utmContent, landingPage: data.landingPage, referrer: data.referrer, activationId: data.activationId,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0));
  const result = await withTransaction(async (client) => {
    const owner = await client.query<{ user_id: string; form_marketing_consent: string | null }>(
      `SELECT user_id,form_marketing_consent FROM sales_settings WHERE form_key=$1`, [formKey],
    );
    const userId = owner.rows[0]?.user_id;
    if (!userId) return false;
    if (data.marketingOptIn && (!owner.rows[0]?.form_marketing_consent?.trim()
      || data.marketingConsentText !== owner.rows[0].form_marketing_consent)) {
      throw new AppError("This form no longer offers email permission. Refresh the page and try again.", 409);
    }
    let campaignId: string | null = null;
    let activationId: string | null = null;
    if (data.activationId) {
      const activation = await client.query<{ id: string; campaign_id: string | null }>(
        `SELECT id,campaign_id FROM sales_marketing_activations WHERE id=$1 AND user_id=$2`, [data.activationId, userId],
      );
      if (!activation.rows[0] || !activationCampaignMatches(data.campaignId, activation.rows[0].campaign_id)) return false;
      activationId = activation.rows[0].id;
      campaignId = activation.rows[0].campaign_id;
    } else if (data.campaignId) {
      const campaign = await client.query(`SELECT id FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`, [data.campaignId, userId]);
      if (campaign.rows[0]) campaignId = data.campaignId;
    }

    const normalizedEmail = data.email?.trim().toLowerCase() || null;
    if (normalizedEmail) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`marketing-contact:${userId}:${normalizedEmail}`]);
    }
    const existing = normalizedEmail
      ? await client.query<{ id: string; name: string }>(
        `SELECT id,name FROM sales_contacts WHERE user_id=$1 AND lower(btrim(email))=$2 ORDER BY created_at ASC,id ASC LIMIT 1 FOR UPDATE`,
        [userId, normalizedEmail],
      )
      : { rows: [] as { id: string; name: string }[] };
    const contact = existing.rows[0]
      ? await client.query<{ id: string; name: string }>(
        `UPDATE sales_contacts SET
          company=COALESCE(NULLIF(company,''),$3),
          notes=CASE WHEN $4::text IS NULL OR btrim($4)='' THEN notes
            WHEN notes IS NULL OR btrim(notes)='' THEN btrim($4) ELSE notes || E'\\n\\n' || btrim($4) END,
          marketing_campaign_id=COALESCE(marketing_campaign_id,$5::uuid),
          marketing_opt_in=marketing_opt_in OR $7::boolean,
          marketing_attribution=CASE WHEN marketing_campaign_id IS NULL THEN $6::jsonb ELSE marketing_attribution END,
          updated_at=now()
         WHERE id=$1 AND user_id=$2 RETURNING id,name`,
        [existing.rows[0].id, userId, data.company?.trim() || null, data.message?.trim() || null, campaignId,
          JSON.stringify(marketingAttribution), Boolean(data.marketingOptIn)],
      )
      : await client.query<{ id: string; name: string }>(
        `INSERT INTO sales_contacts (user_id,name,email,company,notes,source,marketing_opt_in,marketing_campaign_id,marketing_attribution)
         VALUES ($1,$2,$3,$4,$5,'inbound',$6,$7,$8::jsonb) RETURNING id,name`,
        [userId, data.name.trim(), data.email?.trim() || null, data.company?.trim() || null, data.message?.trim() || null,
          Boolean(data.marketingOptIn), campaignId, JSON.stringify(marketingAttribution)],
      );
    const contactId = contact.rows[0].id;
    if (data.marketingOptIn) {
      await client.query(
        `INSERT INTO sales_marketing_consent_events (user_id,contact_id,opted_in,source,evidence)
         VALUES ($1,$2,true,'website_signup',$3)`,
        [userId, contactId, data.marketingConsentText],
      );
    }
    await client.query(
      `INSERT INTO sales_marketing_contact_attributions (user_id,contact_id,campaign_id,activation_id,source,attribution)
       VALUES ($1,$2,$3,$4,'public_form',$5::jsonb)`,
      [userId, contactId, campaignId, activationId, JSON.stringify(marketingAttribution)],
    );
    await client.query(
      `INSERT INTO accountant_activity (user_id,kind,title,detail,entity_type,entity_id,status,payload,persona)
       SELECT $1,'inbound_lead',$2,$3,'sales_contact',$4,'suggested',$5::jsonb,$6
        WHERE NOT EXISTS (
          SELECT 1 FROM accountant_activity WHERE user_id=$1 AND kind='inbound_lead' AND entity_id=$4
            AND status='suggested' AND created_at >= now() - interval '1 hour'
        )`,
      [userId, `Inbound lead: ${contact.rows[0].name}`, data.company?.trim() || null, contactId,
        JSON.stringify({ persona: PERSONA, tool: "route_lead", args: { contactName: contact.rows[0].name } }), PERSONA],
    );
    return true;
  });
  return { ok: result };
}

// ─── Workflow: lead enrichment ──────────────────────────────────────────────────
export async function enrichLead(userId: string, emailText: string): Promise<{ contact: SalesContact | null; isFallback: boolean }> {
  if (!isGeminiLive()) return { contact: null, isFallback: true };
  try {
    const result = await geminiGenerateContent({
      system:
        "Extract the sender/lead from this email. Return ONLY JSON: " +
        '{"name":string,"email":string,"company":string,"title":string,"domain":string,"industry":string}. ' +
        "Infer company/domain/industry from signatures and the email address when possible. Use empty strings if unknown.",
      parts: [{ text: emailText.slice(0, 6000) }],
      json: true,
      maxOutputTokens: 500,
    });
    const o = JSON.parse(result.raw) as Record<string, string>;
    const name = (o.name || "").trim();
    if (!name) return { contact: null, isFallback: false };
    const email = (o.email || "").trim() || undefined;
    let contact = email ? (await listContacts(userId)).find((c) => (c.email ?? "").toLowerCase() === email.toLowerCase()) ?? null : null;
    const fields = { email, company: o.company || undefined, title: o.title || undefined, domain: o.domain || undefined, industry: o.industry || undefined };
    if (contact) {
      contact = await updateContact(userId, contact.id, fields);
    } else {
      contact = await createContact(userId, { name, ...fields, source: "email" });
    }
    if (contact) await recordActivity({ userId, persona: PERSONA, kind: "lead_enriched", title: `Enriched ${contact.name}`, detail: contact.company ?? undefined, entityType: "sales_contact", entityId: contact.id });
    return { contact, isFallback: false };
  } catch {
    return { contact: null, isFallback: true };
  }
}

// ─── Workflow: post-meeting follow-up ────────────────────────────────────────────
async function meetingFollowupCore(user: AppUser, deal: SalesDeal, extracted: { painPoints: string[]; summary: string }): Promise<{ ok: boolean; message: string }> {
  const contact = await getDealContact(user.id, deal);
  const painText = extracted.painPoints.length ? `Pain points: ${extracted.painPoints.join("; ")}.` : "";
  const draft = await draftEmail({
    role: "sales representative",
    purpose: "a follow-up email after a discovery call that acknowledges the client's pain points and proposes next steps",
    context: `Deal: ${deal.title} (${deal.company ?? ""}). ${painText} Summary: ${extracted.summary}`,
  });
  if (contact?.email) {
    await sendProfessionalEmail({ user, to: contact.email, subject: draft.subject, body: draft.body, tag: "sales_meeting_followup" });
  }
  const nextStage: DealStage = deal.stage === "lead" ? "qualified" : deal.stage === "qualified" ? "proposal" : deal.stage;
  await updateDeal(user.id, deal.id, { stage: nextStage });
  await logActivity(user.id, { dealId: deal.id, kind: "meeting_logged", note: `Discovery completed. ${painText} ${extracted.summary}`.trim() });
  await recordActivity({ userId: user.id, persona: PERSONA, kind: "meeting_followup", title: `Follow-up sent for ${deal.title}`, detail: contact?.email ? `to ${contact.name}` : "logged (no contact email)", entityType: "sales_deal", entityId: deal.id });
  return { ok: true, message: contact?.email ? `Follow-up sent to ${contact.name}; deal moved to ${nextStage}.` : `Logged meeting; deal moved to ${nextStage} (no contact email to send to).` };
}

export async function processMeetingTranscript(user: AppUser, dealId: string, transcript: string): Promise<{ ok: boolean; message: string }> {
  const deal = await getDeal(user.id, dealId);
  if (!deal) return { ok: false, message: "Deal not found." };
  let extracted = { painPoints: [] as string[], summary: transcript.slice(0, 400) };
  if (isGeminiLive()) {
    try {
      const result = await geminiGenerateContent({
        system: 'Analyze this sales call transcript. Return ONLY JSON: {"painPoints":string[],"summary":string}.',
        parts: [{ text: transcript.slice(0, 12000) }],
        json: true,
        maxOutputTokens: 600,
      });
      const o = JSON.parse(result.raw) as { painPoints?: unknown; summary?: unknown };
      extracted = {
        painPoints: Array.isArray(o.painPoints) ? o.painPoints.map(String).slice(0, 8) : [],
        summary: typeof o.summary === "string" ? o.summary : extracted.summary,
      };
    } catch {
      /* fall through with defaults */
    }
  }
  return meetingFollowupCore(user, deal, extracted);
}

// ─── Workflow: contract generation ───────────────────────────────────────────────
export async function generateContract(user: AppUser, dealId: string): Promise<{ ok: boolean; message: string; contract?: SalesContract }> {
  const deal = await getDeal(user.id, dealId);
  if (!deal) return { ok: false, message: "Deal not found." };
  const contact = await getDealContact(user.id, deal);
  let fmt: string;
  try { fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: deal.currency, maximumFractionDigits: 2 }).format(deal.amountCents / 100); }
  catch { fmt = `${deal.currency} ${(deal.amountCents / 100).toLocaleString("en-US")}`; }
  const draft = await draftEmail({
    role: "sales representative drafting a service agreement",
    purpose: "a clear, professional proposal/contract with scope, term, and pricing (put the FULL contract text in the body field)",
    context: `Client: ${contact?.name ?? deal.contactName ?? ""}${deal.company ? `, ${deal.company}` : ""}. Deal: ${deal.title}. Total value: ${fmt}.`,
  });
  const contract = await insertContract(user.id, { dealId: deal.id, title: `${deal.title} — Agreement`, body: draft.body, amountCents: deal.amountCents, currency: deal.currency });
  if (contact?.email) {
    await sendProfessionalEmail({
      user, to: contact.email, subject: `Agreement for your review — ${deal.title}`,
      body: `${draft.body}\n\n— To accept, reply "I accept" to this email and we'll countersign.`,
      tag: "sales_contract",
    });
  }
  await logActivity(user.id, { dealId: deal.id, kind: "contract_sent", note: `Contract sent (${fmt})` });
  await recordActivity({ userId: user.id, persona: PERSONA, kind: "contract_sent", title: `Contract sent for ${deal.title}`, detail: contact?.email ? `to ${contact.name}` : "generated (no email)", entityType: "sales_deal", entityId: deal.id });
  return { ok: true, message: contact?.email ? `Contract emailed to ${contact.name}.` : "Contract generated but not emailed — add a contact with an email to this deal, then generate again to send it.", contract };
}

export async function markContractSigned(user: AppUser, dealId: string): Promise<{ ok: boolean; message: string }> {
  const outcome = await withTransaction(async (client) => {
    const dealResult = await client.query<{ contact_id: string | null; stage: DealStage }>(
      `SELECT contact_id,stage FROM sales_deals WHERE id=$1 AND user_id=$2 FOR UPDATE`, [dealId, user.id],
    );
    const deal = dealResult.rows[0];
    if (!deal) return "missing_deal" as const;

    const contractResult = await client.query<{ id: string; status: ContractStatus }>(
      `SELECT id,status FROM sales_contracts
        WHERE user_id=$1 AND deal_id=$2 AND status IN ('sent','signed','draft')
        ORDER BY CASE status WHEN 'sent' THEN 0 WHEN 'signed' THEN 1 ELSE 2 END,created_at DESC
        LIMIT 1 FOR UPDATE`, [user.id, dealId],
    );
    const contract = contractResult.rows[0];
    if (!contract) return "missing_contract" as const;

    const newlySigned = contract.status !== "signed";
    if (newlySigned) {
      await client.query(
        `UPDATE sales_contracts SET status='signed',signed_at=now() WHERE id=$1 AND user_id=$2`, [contract.id, user.id],
      );
    }
    const newlyWon = deal.stage !== "won";
    await client.query(
      `UPDATE sales_deals SET stage='won',last_activity_at=now(),updated_at=now() WHERE id=$1 AND user_id=$2`, [dealId, user.id],
    );
    if (deal.contact_id) {
      await client.query(
        `UPDATE sales_contacts SET marketing_lead_status='converted',updated_at=now() WHERE id=$1 AND user_id=$2`, [deal.contact_id, user.id],
      );
    }
    if (newlySigned || newlyWon) {
      await client.query(
        `INSERT INTO sales_activities(user_id,deal_id,contact_id,kind,note)
         VALUES($1,$2,$3,'contract_signed','Contract signed — deal won')`, [user.id, dealId, deal.contact_id],
      );
    }
    return newlySigned || newlyWon ? "updated" as const : "already_done" as const;
  });
  if (outcome === "missing_deal") return { ok: false, message: "Deal not found." };
  if (outcome === "missing_contract") return { ok: false, message: "No active contract on this deal yet." };
  if (outcome === "updated") {
    try {
      await recordActivity({ userId: user.id, persona: PERSONA, kind: "contract_signed", title: "Contract signed", entityType: "sales_deal", entityId: dealId });
    } catch (error) {
      logger.warn("[marketing] contract conversion saved but the activity feed could not be updated", { userId: user.id, dealId, err: String(error) });
    }
  }
  return { ok: true, message: "Marked signed; deal moved to won." };
}

// ─── Workflow: inbound route optimization ────────────────────────────────────────
export async function routeLead(user: AppUser, contactName: string): Promise<{ ok: boolean; message: string }> {
  const contact = await findContactByName(user.id, contactName);
  if (!contact) return { ok: false, message: "Couldn't find that lead." };
  const reps = await listReps(user.id);
  if (reps.length === 0) return { ok: false, message: "Add a sales rep (with a territory) first." };
  const terr = (contact.territory ?? contact.company ?? "").toLowerCase();
  const rep =
    reps.find((r) => r.territory && terr && (terr.includes(r.territory.toLowerCase()) || r.territory.toLowerCase().includes(terr))) ?? reps[0];
  // Default a 30-min slot tomorrow at 15:00 local server time.
  const start = new Date(); start.setDate(start.getDate() + 1); start.setHours(15, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60_000);
  let scheduled = false;
  if (contact.email) {
    try {
      await scheduleLeadMeeting(user.id, { title: `Intro: ${contact.name} × ${rep.name}`, prospectEmail: contact.email, repEmail: rep.email ?? undefined, startTime: start.toISOString(), endTime: end.toISOString(), notes: `Routed to ${rep.name}${rep.territory ? ` (${rep.territory})` : ""}.` });
      scheduled = true;
    } catch {
      /* calendar not connected — still record the routing */
    }
  }
  await recordActivity({ userId: user.id, persona: PERSONA, kind: "lead_routed", title: `Routed ${contact.name} → ${rep.name}`, detail: scheduled ? "meeting scheduled" : "assigned", entityType: "sales_contact", entityId: contact.id });
  return { ok: true, message: `Assigned ${contact.name} to ${rep.name}${scheduled ? " and scheduled an intro meeting." : "."}` };
}

// ─── Workflow: pipeline cleaning (re-engage) ─────────────────────────────────────
async function reengageDeal(user: AppUser, dealTitle: string): Promise<{ ok: boolean; message: string }> {
  const deal = await findDealByTitle(user.id, dealTitle);
  if (!deal) return { ok: false, message: "Couldn't find that deal." };
  const contact = await getDealContact(user.id, deal);
  const draft = await draftEmail({
    role: "sales representative",
    purpose: "a short, low-pressure re-engagement email to revive a stalled deal",
    context: `Deal: ${deal.title} (${deal.company ?? ""}), currently ${deal.stage}.`,
  });
  if (contact?.email) await sendProfessionalEmail({ user, to: contact.email, subject: draft.subject, body: draft.body, tag: "sales_reengage" });
  await updateDeal(user.id, deal.id, { stage: "nurture" });
  await logActivity(user.id, { dealId: deal.id, kind: "reengaged", note: "Re-engagement sent; moved to nurture" });
  await recordActivity({ userId: user.id, persona: PERSONA, kind: "deal_reengaged", title: `Re-engaged ${deal.title}`, detail: "moved to nurture", entityType: "sales_deal", entityId: deal.id });
  return { ok: true, message: `Re-engaged "${deal.title}"; moved to nurture.` };
}

async function planPipelineCleaning(userId: string): Promise<AutomationProposal[]> {
  const res = await query<{ id: string; title: string }>(
    `SELECT id, title FROM sales_deals
      WHERE user_id = $1 AND stage NOT IN ('won','lost','nurture')
        AND COALESCE(last_activity_at, updated_at) < now() - INTERVAL '30 days'
      ORDER BY COALESCE(last_activity_at, updated_at) ASC LIMIT 10`,
    [userId],
  );
  return res.rows.map((d) => ({ title: `Re-engage stalled deal "${d.title}"`, entityType: "sales_deal", entityId: d.id, tool: "reengage_deal", args: { dealTitle: d.title } }));
}

// ─── Demo seed ──────────────────────────────────────────────────────────────
export async function seedDemo(userId: string): Promise<{ count: number }> {
  // Reset-and-reseed for a clean demo (children first for FK safety).
  await query(`DELETE FROM sales_activities WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM sales_contracts WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM sales_deals WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM sales_contacts WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM sales_reps WHERE user_id = $1`, [userId]);
  const contacts = [
    { name: "Dana Lee", email: "dana@acme.io", company: "Acme Corp", title: "VP Sales", territory: "West" },
    { name: "Sam Rivera", email: "sam@globex.com", company: "Globex LLC", title: "Head of Ops", territory: "East" },
    { name: "Priya Shah", email: "priya@initech.com", company: "Initech", title: "CTO", territory: "West" },
  ];
  for (const c of contacts) await createContact(userId, { ...c, source: "demo" });
  const deals: { title: string; contactName: string; company: string; amountCents: number; stage: DealStage }[] = [
    { title: "Acme — annual platform", contactName: "Dana Lee", company: "Acme Corp", amountCents: 4800000, stage: "proposal" },
    { title: "Globex — pilot expansion", contactName: "Sam Rivera", company: "Globex LLC", amountCents: 1200000, stage: "negotiation" },
    { title: "Initech — new logo", contactName: "Priya Shah", company: "Initech", amountCents: 2600000, stage: "qualified" },
    { title: "Umbrella — renewal", contactName: "", company: "Umbrella Inc", amountCents: 900000, stage: "lead" },
  ];
  for (const d of deals) await createDeal(userId, { ...d, source: "demo" });
  await createRep(userId, { name: "Alex West", email: "alex@yourco.com", territory: "West" });
  await createRep(userId, { name: "Robin East", email: "robin@yourco.com", territory: "East" });
  return { count: deals.length };
}

// ─── AI snapshot ────────────────────────────────────────────────────────────
async function buildSnapshot(userId: string): Promise<string> {
  const [deals, contacts, contracts, connLine] = await Promise.all([
    listDeals(userId), listContacts(userId), listContracts(userId), salesConnectionsLine(userId),
  ]);
  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US")}`;
  return [
    connLine,
    `Open pipeline: ${fmt(open.reduce((s, d) => s + d.amountCents, 0))} across ${open.length} deal(s). Contacts: ${contacts.length}. Contracts out: ${contracts.filter((c) => c.status === "sent").length}.`,
    "Deals:",
    ...deals.slice(0, 20).map((d) => `- ${d.title} | ${d.company ?? "—"} | ${fmt(d.amountCents)} | stage=${d.stage} | contact=${d.contactName ?? "—"}`),
    "Contacts:",
    ...contacts.slice(0, 15).map((c) => `- ${c.name} | ${c.company ?? "—"} | ${c.email ?? "no-email"} | ${c.title ?? ""}${c.territory ? ` | ${c.territory}` : ""}`),
  ].join("\n");
}

// ─── Agent tools ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = [
  "You are the user's AI sales & business-development assistant inside the Interlink app.",
  "Answer questions about the pipeline/contacts using ONLY the DATA SNAPSHOT, or perform an action by calling a function when the user asks.",
  "Core workflows you can run:",
  "- Lead enrichment: when the user pastes/attaches an email, call enrich_lead to extract and add/update the contact.",
  "- Post-meeting follow-up: given a call transcript (text or attached file), extract the client's pain points and call meeting_followup for the relevant deal — it emails a follow-up and advances the stage.",
  "- Contract generation: generate_contract drafts a proposal from a deal and emails it for signature; mark_contract_signed closes the deal won.",
  "- Inbound routing: route_lead assigns a lead to a rep by territory and schedules an intro meeting.",
  "- Pipeline hygiene: reengage_deal revives a stalled deal, advance_stage moves a deal, and post_pipeline_to_slack / sync_pipeline_to_trello share the pipeline.",
  "- Campaigns: draft_campaign creates a saved email draft for review. Never send a campaign from chat; the marketer reviews audience and copy in the Campaigns workspace and sends explicitly there.",
  "Resolve deals and contacts by their name from the snapshot; never invent contacts, companies, or numbers.",
  "You never send anything without confirmation — the app asks the user to confirm each write action before it executes.",
  "For marketing work, use only connected tools shown in the connected-app context. Prefer Mailchimp for subscriber audiences, unsubscribe handling, campaign delivery, and engagement reports; prefer Google Analytics and Search Console for owned-site performance; use Facebook Pages and Instagram only for the connected professional accounts; use Canva for brand assets.",
  "When reporting performance, state the source, account/property, and date range; distinguish observed metrics from recommendations. Never invent results or infer causation from correlation. Never change ad budgets, targeting, or live posts without an explicit action confirmation.",
  "For a cross-channel brief, draft channel-specific content and a review plan first. Say clearly when a connected provider cannot schedule or publish the requested format instead of claiming it was done.",
].join("\n");

const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost", "nurture"];
const TOOLS: GeminiToolFunction[] = [
  { name: "create_contact", description: "Add a new sales contact/prospect.", parameters: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, company: { type: "string" }, title: { type: "string" } }, required: ["name"] } },
  { name: "create_deal", description: "Create a new deal/opportunity.", parameters: { type: "object", properties: { title: { type: "string" }, contactName: { type: "string" }, company: { type: "string" }, amountCents: { type: "number" }, stage: { type: "string", enum: STAGES } }, required: ["title"] } },
  { name: "advance_stage", description: "Move a deal to a new pipeline stage.", parameters: { type: "object", properties: { dealTitle: { type: "string" }, stage: { type: "string", enum: STAGES } }, required: ["dealTitle", "stage"] } },
  { name: "draft_followup", description: "Draft and send a follow-up email to a contact.", parameters: { type: "object", properties: { contactName: { type: "string" }, note: { type: "string" } }, required: ["contactName"] } },
  { name: "draft_campaign", description: "Create a saved marketing email draft for human review. Optionally define an audience filter (company/title/territory). This never sends email.", parameters: { type: "object", properties: { topic: { type: "string" }, audience: { type: "string", description: "Optional filter, e.g. a company, title, or territory." } }, required: ["topic"] } },
  { name: "enrich_lead", description: "Extract & enrich a lead from a pasted or attached email; creates/updates a contact.", parameters: { type: "object", properties: { emailText: { type: "string", description: "The email text to parse (if pasted)." } } } },
  { name: "meeting_followup", description: "After a call: send a follow-up that addresses pain points and advance the deal.", parameters: { type: "object", properties: { dealTitle: { type: "string" }, painPoints: { type: "array", items: { type: "string" } }, summary: { type: "string" } }, required: ["dealTitle"] } },
  { name: "generate_contract", description: "Generate a proposal/contract from a deal and email it for signature.", parameters: { type: "object", properties: { dealTitle: { type: "string" } }, required: ["dealTitle"] } },
  { name: "mark_contract_signed", description: "Mark a deal's contract as signed (moves the deal to won).", parameters: { type: "object", properties: { dealTitle: { type: "string" } }, required: ["dealTitle"] } },
  { name: "route_lead", description: "Assign a lead to a rep by territory and schedule an intro meeting.", parameters: { type: "object", properties: { contactName: { type: "string" } }, required: ["contactName"] } },
  { name: "reengage_deal", description: "Send a re-engagement email for a stalled deal and move it to nurture.", parameters: { type: "object", properties: { dealTitle: { type: "string" } }, required: ["dealTitle"] } },
  { name: "sync_pipeline_to_trello", description: "Push your open deals to your Trello board as cards (one per stage list).", parameters: { type: "object", properties: {} } },
  { name: "import_from_trello", description: "Pull cards from your Trello board and create deals for any that aren't in the pipeline yet.", parameters: { type: "object", properties: {} } },
  { name: "post_pipeline_to_slack", description: "Post a pipeline digest to a Slack channel.", parameters: { type: "object", properties: { channel: { type: "string", description: "Channel name or id (defaults to a channel you're in)." } } } },
  { name: "log_activity", description: "Log a note to the feed.", parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
];

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "create_contact": return `Add contact ${args.name ?? ""}${args.company ? ` (${args.company})` : ""}.`;
    case "create_deal": return `Create deal "${args.title ?? ""}"${args.company ? ` for ${args.company}` : ""}.`;
    case "advance_stage": return `Move "${args.dealTitle ?? "deal"}" to ${args.stage}.`;
    case "draft_followup": return `Draft & send a follow-up to ${args.contactName ?? "the contact"}.`;
    case "draft_campaign": return `Create a campaign draft about ${args.topic ?? "your product"}${args.audience ? ` for ${args.audience}` : " for your contacts"}.`;
    case "enrich_lead": return `Enrich a lead from the email.`;
    case "meeting_followup": return `Send a post-meeting follow-up for "${args.dealTitle ?? "the deal"}".`;
    case "generate_contract": return `Generate & send a contract for "${args.dealTitle ?? "the deal"}".`;
    case "mark_contract_signed": return `Mark "${args.dealTitle ?? "the deal"}"'s contract signed.`;
    case "route_lead": return `Route ${args.contactName ?? "the lead"} to a rep & schedule a meeting.`;
    case "reengage_deal": return `Re-engage "${args.dealTitle ?? "the deal"}" (→ nurture).`;
    case "sync_pipeline_to_trello": return `Sync your open deals to your Trello board.`;
    case "import_from_trello": return `Import new cards from your Trello board as deals.`;
    case "post_pipeline_to_slack": return `Post a pipeline digest to Slack${args.channel ? ` (#${String(args.channel).replace(/^#/, "")})` : ""}.`;
    case "log_activity": return `Log: ${args.note ?? ""}`;
    default: return `Run ${name}.`;
  }
}

async function executeTool(user: AppUser, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    switch (name) {
      case "create_contact": {
        const c = await createContact(user.id, { name: String(args.name ?? "").trim(), email: args.email ? String(args.email) : undefined, company: args.company ? String(args.company) : undefined, title: args.title ? String(args.title) : undefined, source: "assistant" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "contact_created", title: `Added contact ${c.name}`, entityType: "sales_contact", entityId: c.id });
        return { ok: true, message: `Added ${c.name}.` };
      }
      case "create_deal": {
        const d = await createDeal(user.id, { title: String(args.title ?? "").trim(), contactName: args.contactName ? String(args.contactName) : undefined, company: args.company ? String(args.company) : undefined, amountCents: typeof args.amountCents === "number" ? args.amountCents : undefined, stage: args.stage as DealStage | undefined, source: "assistant" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "deal_created", title: `Created deal ${d.title}`, entityType: "sales_deal", entityId: d.id });
        return { ok: true, message: `Created deal "${d.title}".` };
      }
      case "advance_stage": {
        const match = await findDealByTitle(user.id, String(args.dealTitle ?? ""));
        if (!match) return { ok: false, message: "Couldn't find that deal." };
        await updateDeal(user.id, match.id, { stage: args.stage as DealStage });
        await logActivity(user.id, { dealId: match.id, kind: "stage_changed", note: `→ ${args.stage}` });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "deal_advanced", title: `${match.title} → ${args.stage}`, entityType: "sales_deal", entityId: match.id });
        return { ok: true, message: `Moved "${match.title}" to ${args.stage}.` };
      }
      case "draft_followup": {
        const c = await findContactByName(user.id, String(args.contactName ?? ""));
        if (!c) return { ok: false, message: "Couldn't find that contact." };
        if (!c.email) return { ok: false, message: `No email on file for ${c.name}.` };
        const draft = await draftEmail({ role: "sales representative", purpose: "a warm, concise follow-up email to a prospect", context: `Contact: ${c.name}${c.company ? `, ${c.company}` : ""}${c.title ? `, ${c.title}` : ""}. ${args.note ? `Note: ${args.note}` : ""}` });
        await sendProfessionalEmail({ user, to: c.email, subject: draft.subject, body: draft.body, tag: "sales_followup" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "followup_sent", title: `Follow-up sent to ${c.name}`, detail: draft.subject, entityType: "sales_contact", entityId: c.id });
        return { ok: true, message: `Follow-up sent to ${c.name}.` };
      }
      case "draft_campaign": {
        const campaign = await createMarketingCampaign(user.id, { topic: String(args.topic ?? "").trim(), audience: args.audience ? String(args.audience) : undefined });
        return { ok: true, message: `Saved campaign draft "${campaign.subject}". Review the copy and choose a Mailchimp audience in the Campaigns workspace before any delivery.` };
      }
      case "enrich_lead": {
        const text = String(args.emailText ?? "").trim();
        if (!text) return { ok: false, message: "Paste or attach the email to enrich." };
        const { contact, isFallback } = await enrichLead(user.id, text);
        if (isFallback) return { ok: false, message: "AI is offline — couldn't enrich the lead." };
        if (!contact) return { ok: false, message: "Couldn't extract a lead from that email." };
        return { ok: true, message: `Enriched ${contact.name}${contact.company ? ` (${contact.company})` : ""}.` };
      }
      case "meeting_followup": {
        const deal = await findDealByTitle(user.id, String(args.dealTitle ?? ""));
        if (!deal) return { ok: false, message: "Couldn't find that deal." };
        const painPoints = Array.isArray(args.painPoints) ? (args.painPoints as unknown[]).map(String) : [];
        return meetingFollowupCore(user, deal, { painPoints, summary: String(args.summary ?? "") });
      }
      case "generate_contract": {
        const deal = await findDealByTitle(user.id, String(args.dealTitle ?? ""));
        if (!deal) return { ok: false, message: "Couldn't find that deal." };
        const r = await generateContract(user, deal.id);
        return { ok: r.ok, message: r.message };
      }
      case "mark_contract_signed": {
        const deal = await findDealByTitle(user.id, String(args.dealTitle ?? ""));
        if (!deal) return { ok: false, message: "Couldn't find that deal." };
        return markContractSigned(user, deal.id);
      }
      case "route_lead": return routeLead(user, String(args.contactName ?? ""));
      case "reengage_deal": return reengageDeal(user, String(args.dealTitle ?? ""));
      case "sync_pipeline_to_trello": return syncPipelineToTrello(user);
      case "import_from_trello": return importDealsFromTrello(user);
      case "post_pipeline_to_slack": return postPipelineDigestToSlack(user, args.channel ? String(args.channel) : undefined);
      case "log_activity": {
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "note", title: String(args.note ?? "Note") });
        return { ok: true, message: "Logged." };
      }
      default:
        return { ok: false, message: `Unsupported action: ${name}.` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Row mappers ────────────────────────────────────────────────────────────
function mapContact(r: {
  id: string; name: string; email: string | null; company: string | null; title: string | null; phone: string | null;
  notes: string | null; territory: string | null; domain: string | null; industry: string | null; source: string;
  marketing_opt_in: boolean; marketing_campaign_id: string | null; marketing_attribution: Record<string, string>;
  marketing_lead_status: MarketingLeadStatus; last_contacted_at: Date | null; created_at: Date;
}): SalesContact {
  return { id: r.id, name: r.name, email: r.email, company: r.company, title: r.title, phone: r.phone, notes: r.notes, territory: r.territory, domain: r.domain, industry: r.industry, source: r.source, marketingOptIn: r.marketing_opt_in,
    marketingCampaignId: r.marketing_campaign_id, marketingAttribution: r.marketing_attribution ?? {},
    marketingLeadStatus: r.marketing_lead_status,
    lastContactedAt: r.last_contacted_at, createdAt: r.created_at };
}
function mapDeal(r: {
  id: string; title: string; contact_id: string | null; marketing_campaign_id: string | null; contact_name: string | null; company: string | null; amount_cents: string | number; currency: string; stage: DealStage; close_date: string | null; notes: string | null; owner_rep: string | null; last_activity_at: Date | null; source: string; created_at: Date;
}): SalesDeal {
  return { id: r.id, title: r.title, contactId: r.contact_id, marketingCampaignId: r.marketing_campaign_id, contactName: r.contact_name, company: r.company, amountCents: typeof r.amount_cents === "string" ? parseInt(r.amount_cents, 10) : r.amount_cents, currency: r.currency, stage: r.stage, closeDate: r.close_date, notes: r.notes, ownerRep: r.owner_rep, lastActivityAt: r.last_activity_at, source: r.source, createdAt: r.created_at };
}
function mapContract2(r: {
  id: string; deal_id: string | null; title: string; body: string | null; amount_cents: string | number; currency: string; status: ContractStatus; sent_at: Date | null; signed_at: Date | null; created_at: Date;
}): SalesContract {
  return { id: r.id, dealId: r.deal_id, title: r.title, body: r.body, amountCents: typeof r.amount_cents === "string" ? parseInt(r.amount_cents, 10) : r.amount_cents, currency: r.currency, status: r.status, sentAt: r.sent_at, signedAt: r.signed_at, createdAt: r.created_at };
}

// ─── Vertical export ────────────────────────────────────────────────────────
export const salesVertical: PersonaVertical = {
  persona: PERSONA,
  tools: TOOLS,
  systemPrompt: SYSTEM_PROMPT,
  buildSnapshot,
  executeTool,
  summarizeAction,
  seedDemo,
  automations: [
    {
      type: "pipeline_cleaning",
      title: "Pipeline cleaning",
      description: "Every 30 days, re-engage stalled deals and move them to nurture",
      cadenceDays: 30,
      defaultAutonomy: "suggest",
      plan: planPipelineCleaning,
    },
  ],
};
