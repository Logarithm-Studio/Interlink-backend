import { Router, Request } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { marketingAnalyticsRateLimit, marketingAnalyticsTargetsRateLimit, marketingCrmSyncRateLimit, marketingPostStatusRateLimit, marketingPublishRateLimit, marketingResearchRateLimit, marketingTodoistSyncRateLimit } from "../middleware/rateLimit";
import {
  approveMarketingContent, cancelMarketingContent, completeMarketingContent, createMarketingContent, listMarketingContent,
  listMarketingApprovalHistory, listMarketingContentRevisions, markMarketingContentPublished, planMarketingContent, requeueMarketingContentPublish,
  repurposeMarketingCampaign, updateMarketingContent, submitMarketingContent,
  type MarketingChannel,
} from "../services/professional/marketing/content.service";
import {
  cancelMarketingFollowup, completeMarketingFollowup, createMarketingFollowup,
  assignMarketingLead, exportMarketingFollowupToTodoist, getMarketingReminderPreferences, listMarketingFollowups, listMarketingLeads, requestMarketingReminderDeliveryRetry, rescheduleMarketingFollowup, saveMarketingReminderPreferences, setMarketingFollowupReminder, syncMarketingFollowupFromTodoist, updateMarketingLeadStatus,
} from "../services/professional/marketing/leads.service";
import { createMarketingResearch } from "../services/professional/marketing/research.service";
import { exportMarketingCampaignToNotion, exportMarketingCampaignToNotionDataSource, getMarketingNotionDataSourceSchema, getMarketingNotionExport, reconcileMarketingNotionExport, searchMarketingNotionDataSources, searchMarketingNotionParents, type MarketingNotionMapping } from "../services/professional/marketing/notion-export.service";
import { getMarketingHubSpotSetup, HUBSPOT_IMPORT_FIELDS, importHubSpotChangesForMarketingDeal, previewHubSpotChangesForMarketingDeal, previewMarketingDealHubSpotSync, saveMarketingHubSpotSetup, syncMarketingDealToHubSpot } from "../services/professional/marketing/hubspot-sync.service";
import { getMarketingHubSpotMonitoring, listMarketingHubSpotConflicts, listMarketingHubSpotResolutions, setMarketingHubSpotMonitoring } from "../services/professional/marketing/hubspot-monitoring.service";
import { getMarketingAnalyticsTargets, listMarketingAnalyticsSnapshots, refreshMarketingAnalytics } from "../services/professional/marketing/analytics.service";
import { getMarketingPublishTargets, publishMarketingContent, type MarketingPublishProvider } from "../services/professional/marketing/social-publishing.service";
import { scheduleMarketingSocialPublish, unscheduleMarketingSocialPublish } from "../services/professional/marketing/social-scheduling.service";
import { createMarketingOpportunity, getMarketingPerformance, type MarketingLeadStatus } from "../services/professional/sales/sales.service";
import { MarketingActivationCreateBody, MarketingActivationPatchBody } from "../services/professional/marketing/activation.model";
import { createMarketingActivation, listMarketingActivationEvents, listMarketingActivations, updateMarketingActivation } from "../services/professional/marketing/activations.service";
import { getMarketingAnalyticsRefreshPreference, saveMarketingAnalyticsRefreshPreference } from "../services/professional/marketing/analytics-schedule.service";
import type { MarketingAnalyticsRefreshTargets } from "../services/professional/marketing/analytics-schedule.model";
import { checkMarketingPublishedPost, getMarketingPostMetricsHistory, listLatestMarketingPostMetrics } from "../services/professional/marketing/post-monitoring.service";
import { getMarketingCampaignTodoistProject, getMarketingTodoistProjectPreference, saveMarketingCampaignTodoistProject, saveMarketingTodoistProjectPreference } from "../services/professional/marketing/todoist-project.service";
import { getMarketingPostMonitoringPreference, saveMarketingPostMonitoringPreference } from "../services/professional/marketing/post-monitoring-schedule.service";
import type { MarketingPostProvider } from "../services/professional/marketing/post-monitoring.model";
import { getMarketingActivationTrackedLink, recordMarketingActivationRedirect } from "../services/professional/marketing/activation-link.service";

const router = Router();
router.get("/activation-visit/:token", async (req, res, next) => {
  try {
    const token = z.string().regex(/^[A-Za-z0-9_-]{40,64}$/).safeParse(req.params.token);
    const target = token.success ? await recordMarketingActivationRedirect(token.data) : null;
    if (!target) { res.status(404).type("text").send("This tracked activation link is unavailable."); return; }
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" });
    res.redirect(302, target);
  } catch (error) { next(error); }
});
router.use(authMiddleware as never);
const userId = (req: Request) => (req as unknown as AuthenticatedRequest).user.id;
const Channels = z.enum(["email", "instagram", "facebook", "linkedin", "youtube", "blog", "landing_page", "search", "ad", "influencer", "event", "other"]);
const dateTime = z.string().datetime();
const LeadStatuses = z.enum(["new", "qualified", "following_up", "nurture", "converted", "disqualified"]);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Use a real calendar date.");
router.post("/campaigns/:id/research", marketingResearchRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new BadRequestError("Choose a valid campaign.");
    const research = await createMarketingResearch(userId(req), id.data);
    res.status(201).json({ research });
  } catch (error) { next(error); }
});
router.get("/campaigns/:id/notion-targets", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const search = z.string().trim().min(2).max(100).safeParse(req.query.q);
    if (!id.success || !search.success) throw new BadRequestError("Choose a campaign and enter at least two characters to search Notion pages.");
    res.json({ pages: await searchMarketingNotionParents(userId(req), id.data, search.data) });
  } catch (error) { next(error); }
});
router.post("/campaigns/:id/notion", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = z.object({ parentId: z.string().trim().min(1).max(100) }).safeParse(req.body ?? {});
    if (!id.success || !parsed.success) throw new BadRequestError("Choose a campaign and a Notion page.");
    const result = await exportMarketingCampaignToNotion(userId(req), id.data, parsed.data.parentId);
    res.status(result.alreadyExported ? 200 : 201).json(result);
  } catch (error) { next(error); }
});
router.get("/campaigns/:id/notion-data-sources", marketingAnalyticsTargetsRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const search = z.string().trim().min(2).max(100).safeParse(req.query.q);
    if (!id.success || !search.success) throw new BadRequestError("Choose a campaign and enter at least two characters to search Notion databases.");
    res.json({ dataSources: await searchMarketingNotionDataSources(userId(req), id.data, search.data) });
  } catch (error) { next(error); }
});
router.get("/campaigns/:id/notion-data-sources/:sourceId/schema", marketingAnalyticsTargetsRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const sourceId = z.string().trim().min(1).max(100).safeParse(req.params.sourceId);
    if (!id.success || !sourceId.success) throw new BadRequestError("Choose a valid campaign and Notion database.");
    res.json({ schema: await getMarketingNotionDataSourceSchema(userId(req), id.data, sourceId.data) });
  } catch (error) { next(error); }
});
router.get("/campaigns/:id/notion-export", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new BadRequestError("Choose a valid campaign.");
    res.json({ export: await getMarketingNotionExport(userId(req), id.data) });
  } catch (error) { next(error); }
});
router.post("/campaigns/:id/notion-database", marketingCrmSyncRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const mapping = z.object({
      campaignId: z.string().trim().min(1).max(100), objective: z.string().trim().max(100).nullable().optional(),
      audience: z.string().trim().max(100).nullable().optional(), offer: z.string().trim().max(100).nullable().optional(),
      successMetric: z.string().trim().max(100).nullable().optional(), channels: z.string().trim().max(100).nullable().optional(),
      startDate: z.string().trim().max(100).nullable().optional(), endDate: z.string().trim().max(100).nullable().optional(),
      budget: z.string().trim().max(100).nullable().optional(),
    }).strict();
    const body = z.object({ dataSourceId: z.string().trim().min(1).max(100), databaseId: z.string().trim().min(1).max(100), mapping }).safeParse(req.body ?? {});
    if (!id.success || !body.success) throw new BadRequestError("Choose a Notion database and map its campaign ID property.");
    const result = await exportMarketingCampaignToNotionDataSource(userId(req), id.data, {
      id: body.data.dataSourceId, databaseId: body.data.databaseId, title: "", url: "",
    }, body.data.mapping as MarketingNotionMapping);
    res.status(result?.status === "synced" ? 201 : 202).json({ export: result });
  } catch (error) { next(error); }
});
router.post("/campaigns/:id/notion-database/reconcile", marketingPostStatusRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z.object({ confirmNoExistingRow: z.boolean().optional().default(false) }).safeParse(req.body ?? {});
    if (!id.success || !body.success) throw new BadRequestError("Choose a valid campaign and review confirmation.");
    res.json(await reconcileMarketingNotionExport(userId(req), id.data, body.data.confirmNoExistingRow));
  } catch (error) { next(error); }
});
router.post("/campaigns/:id/repurpose", async (req, res, next) => {
  try {
    const parsed = z.object({ channels: z.array(Channels).min(1).max(12).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Choose valid campaign channels.");
    res.json({ result: await repurposeMarketingCampaign(userId(req), req.params.id, parsed.data.channels as MarketingChannel[] | undefined) });
  } catch (error) { next(error); }
});

router.get("/campaigns/:id/todoist-project", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new BadRequestError("Choose a valid campaign.");
    res.json({ mapping: await getMarketingCampaignTodoistProject(userId(req), id.data) });
  } catch (error) { next(error); }
});

router.put("/campaigns/:id/todoist-project", marketingTodoistSyncRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = z.object({ projectId: z.string().trim().min(1).max(100).nullable() }).safeParse(req.body ?? {});
    if (!id.success || !parsed.success) throw new BadRequestError("Choose a valid Todoist project or use the account default.");
    res.json({ mapping: await saveMarketingCampaignTodoistProject(userId(req), id.data, parsed.data.projectId) });
  } catch (error) { next(error); }
});

router.get("/leads", async (req, res, next) => {
  try { res.json({ leads: await listMarketingLeads(userId(req)) }); }
  catch (error) { next(error); }
});

router.get("/performance", async (req, res, next) => {
  try { res.json(await getMarketingPerformance(userId(req))); }
  catch (error) { next(error); }
});

router.get("/activations", async (req, res, next) => {
  try { res.json({ activations: await listMarketingActivations(userId(req)) }); }
  catch (error) { next(error); }
});

router.post("/activations/:id/tracked-link", marketingPostStatusRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new BadRequestError("Choose a valid marketing activation.");
    res.json(await getMarketingActivationTrackedLink(userId(req), id.data));
  } catch (error) { next(error); }
});

router.post("/activations", async (req, res, next) => {
  try {
    const parsed = MarketingActivationCreateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Add an event or creator activation with a name, valid costs, and an optional campaign link.");
    res.status(201).json({ activation: await createMarketingActivation(userId(req), parsed.data) });
  } catch (error) { next(error); }
});

router.patch("/activations/:id", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = MarketingActivationPatchBody.safeParse(req.body ?? {});
    if (!id.success || !parsed.success) throw new BadRequestError("Provide a valid activation ID and at least one valid field to update.");
    res.json({ activation: await updateMarketingActivation(userId(req), id.data, parsed.data) });
  } catch (error) { next(error); }
});

router.get("/activations/:id/history", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new BadRequestError("Choose a valid marketing activation.");
    res.json({ events: await listMarketingActivationEvents(userId(req), id.data) });
  } catch (error) { next(error); }
});

router.get("/performance/analytics-targets", marketingAnalyticsTargetsRateLimit, async (req, res, next) => {
  try { res.json({ targets: await getMarketingAnalyticsTargets(userId(req)) }); }
  catch (error) { next(error); }
});

router.get("/performance/analytics-refresh", async (req, res, next) => {
  try { res.json({ preference: await getMarketingAnalyticsRefreshPreference(userId(req)) }); }
  catch (error) { next(error); }
});

router.put("/performance/analytics-refresh", marketingAnalyticsTargetsRateLimit, async (req, res, next) => {
  try {
    const targets = z.object({
      ga4PropertyId: z.string().regex(/^\d{3,20}$/).optional(),
      searchConsoleSite: z.string().trim().min(1).max(500).optional(),
      facebookPageId: z.string().regex(/^\d{5,30}$/).optional(),
      instagramUserId: z.string().regex(/^(?:me|\d{5,30})$/).optional(),
      stripeBalance: z.boolean().optional(),
      googleAdsCustomerId: z.string().regex(/^\d{7,20}$/).optional(),
    });
    const parsed = z.object({ enabled: z.boolean(), rangeDays: z.union([z.literal(30), z.literal(90)]), targets }).safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Select a valid date range and connected analytics accounts for the daily refresh.");
    const preference = await saveMarketingAnalyticsRefreshPreference(userId(req), {
      enabled: parsed.data.enabled,
      rangeDays: parsed.data.rangeDays,
      targets: parsed.data.targets as MarketingAnalyticsRefreshTargets,
    });
    res.json({ preference });
  } catch (error) { next(error); }
});

router.get("/performance/analytics-snapshots", async (req, res, next) => {
  try { res.json({ snapshots: await listMarketingAnalyticsSnapshots(userId(req)) }); }
  catch (error) { next(error); }
});

router.post("/performance/analytics-snapshots", marketingAnalyticsRateLimit, async (req, res, next) => {
  try {
    const parsed = z.object({
      ga4PropertyId: z.string().regex(/^\d{3,20}$/).optional(),
      searchConsoleSite: z.string().trim().min(1).max(500).optional(),
      facebookPageId: z.string().regex(/^\d{5,30}$/).optional(),
      instagramUserId: z.string().regex(/^(?:me|\d{5,30})$/).optional(),
      stripeBalance: z.boolean().optional(),
      googleAdsCustomerId: z.string().regex(/^\d{7,20}$/).optional(),
      startDate: dateOnly,
      endDate: dateOnly,
    }).refine((body) => Boolean(body.ga4PropertyId || body.searchConsoleSite || body.facebookPageId || body.instagramUserId || body.stripeBalance || body.googleAdsCustomerId), "Select a Google Analytics property, Search Console site, social account, Google Ads customer, or Stripe balance activity.")
      .safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Select a connected analytics property or social account and provide valid dates.");
    const start = Date.parse(`${parsed.data.startDate}T00:00:00.000Z`);
    const end = Date.parse(`${parsed.data.endDate}T00:00:00.000Z`);
    if (start > end || end > Date.now() || (end - start) / 86_400_000 > 89) {
      throw new BadRequestError("Choose a past date range no longer than 90 days.");
    }
    const result = await refreshMarketingAnalytics(userId(req), parsed.data);
    res.json({ result, snapshots: await listMarketingAnalyticsSnapshots(userId(req)) });
  } catch (error) { next(error); }
});

router.get("/hubspot/setup", marketingCrmSyncRateLimit, async (req, res, next) => {
  try { res.json({ setup: await getMarketingHubSpotSetup(userId(req)) }); }
  catch (error) { next(error); }
});

router.put("/hubspot/setup", marketingCrmSyncRateLimit, async (req, res, next) => {
  try {
    const StageMappings = z.object({
      lead: z.string().trim().min(1).max(100).nullable().optional(),
      qualified: z.string().trim().min(1).max(100).nullable().optional(),
      proposal: z.string().trim().min(1).max(100).nullable().optional(),
      negotiation: z.string().trim().min(1).max(100).nullable().optional(),
      nurture: z.string().trim().min(1).max(100).nullable().optional(),
      won: z.string().trim().min(1).max(100).nullable().optional(),
      lost: z.string().trim().min(1).max(100).nullable().optional(),
    }).strict();
    const parsed = z.object({
      pipelineId: z.string().trim().min(1).max(100),
      stageMappings: StageMappings,
      ownerMappings: z.record(z.string().uuid(), z.string().trim().min(1).max(100)),
    }).safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Choose a HubSpot pipeline, valid stage mappings, and owners from the current setup.");
    const stageMappings = Object.fromEntries(
      Object.entries(parsed.data.stageMappings).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    res.json({ mapping: await saveMarketingHubSpotSetup(userId(req), {
      pipelineId: parsed.data.pipelineId,
      stageMappings: stageMappings as never,
      ownerMappings: parsed.data.ownerMappings,
    }) });
  } catch (error) { next(error); }
});

router.get("/hubspot/conflicts", marketingCrmSyncRateLimit, async (req, res, next) => {
  try { res.json({ conflicts: await listMarketingHubSpotConflicts(userId(req)) }); }
  catch (error) { next(error); }
});

router.get("/hubspot/resolutions", marketingCrmSyncRateLimit, async (req, res, next) => {
  try { res.json({ resolutions: await listMarketingHubSpotResolutions(userId(req)) }); }
  catch (error) { next(error); }
});

router.get("/deals/:id/hubspot-preview", marketingCrmSyncRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new BadRequestError("Choose a valid marketing deal.");
    res.json({ preview: await previewMarketingDealHubSpotSync(userId(req), id.data) });
  } catch (error) { next(error); }
});

router.get("/deals/:id/hubspot-import-preview", marketingCrmSyncRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new BadRequestError("Choose a valid marketing opportunity.");
    res.json({ preview: await previewHubSpotChangesForMarketingDeal(userId(req), id.data) });
  } catch (error) { next(error); }
});

router.post("/deals/:id/hubspot-import", marketingCrmSyncRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = z.object({
      confirmed: z.literal(true),
      expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      fields: z.array(z.enum(HUBSPOT_IMPORT_FIELDS)).min(1).max(HUBSPOT_IMPORT_FIELDS.length),
    }).safeParse(req.body ?? {});
    if (!id.success || !parsed.success) throw new BadRequestError("Review the current HubSpot changes and confirm the fields to import.");
    const { expectedFingerprint, ...confirmation } = parsed.data;
    res.json({ result: await importHubSpotChangesForMarketingDeal(userId(req), id.data, expectedFingerprint, confirmation.fields) });
  } catch (error) { next(error); }
});

router.post("/deals/:id/hubspot-sync", marketingCrmSyncRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z.object({ confirmed: z.literal(true), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(req.body ?? {});
    if (!id.success || !body.success) throw new BadRequestError("Review the current HubSpot changes and confirm them before syncing.");
    res.json({ result: await syncMarketingDealToHubSpot(userId(req), id.data, body.data.expectedFingerprint) });
  } catch (error) { next(error); }
});

router.get("/deals/:id/hubspot-monitoring", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new BadRequestError("Choose a valid marketing opportunity.");
    res.json({ monitoring: await getMarketingHubSpotMonitoring(userId(req), id.data) });
  } catch (error) { next(error); }
});

router.put("/deals/:id/hubspot-monitoring", marketingCrmSyncRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body ?? {});
    if (!id.success || !body.success) throw new BadRequestError("Choose whether to enable read-only HubSpot change checks.");
    res.json({ monitoring: await setMarketingHubSpotMonitoring(userId(req), id.data, body.data.enabled) });
  } catch (error) { next(error); }
});

const OpportunityBody = z.object({
  title: z.string().trim().min(1).max(200), campaignId: z.string().uuid().optional(),
  amountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
  closeDate: dateOnly.optional(),
  notes: z.string().trim().max(4000).optional(),
});
router.post("/leads/:id/opportunities", async (req, res, next) => {
  try {
    const parsed = OpportunityBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Provide an opportunity title and a valid amount, currency, and close date.");
    const deal = await createMarketingOpportunity(userId(req), {
      ...parsed.data, contactId: req.params.id, currency: parsed.data.currency?.toUpperCase(),
    });
    res.status(201).json({ deal });
  } catch (error) { next(error); }
});

router.patch("/leads/:id/status", async (req, res, next) => {
  try {
    const parsed = z.object({ status: LeadStatuses }).safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Choose a valid lead stage.");
    await updateMarketingLeadStatus(userId(req), req.params.id, parsed.data.status as MarketingLeadStatus);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.patch("/leads/:id/assignment", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = z.object({ repId: z.string().uuid().nullable() }).safeParse(req.body ?? {});
    if (!id.success || !parsed.success) throw new BadRequestError("Choose a valid lead and a rep from your roster, or clear the assignment.");
    await assignMarketingLead(userId(req), id.data, parsed.data.repId);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get("/followups", async (req, res, next) => {
  try {
    const parsed = req.query.status === undefined
      ? { success: true as const, data: "open" as const }
      : z.enum(["open", "completed", "cancelled"]).safeParse(req.query.status);
    if (!parsed.success) throw new BadRequestError("Choose a valid follow-up status.");
    res.json({ followups: await listMarketingFollowups(userId(req), parsed.data) });
  } catch (error) { next(error); }
});

router.get("/followup-reminder-preferences", async (req, res, next) => {
  try { res.json({ preferences: await getMarketingReminderPreferences(userId(req)) }); }
  catch (error) { next(error); }
});

router.put("/followup-reminder-preferences", async (req, res, next) => {
  try {
    const parsed = z.object({ pushEnabled: z.boolean(), emailEnabled: z.boolean() }).safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Choose valid push and email reminder preferences.");
    res.json({ preferences: await saveMarketingReminderPreferences(userId(req), parsed.data) });
  } catch (error) { next(error); }
});

router.get("/todoist-project", async (req, res, next) => {
  try { res.json({ preference: await getMarketingTodoistProjectPreference(userId(req)) }); }
  catch (error) { next(error); }
});

router.put("/todoist-project", async (req, res, next) => {
  try {
    const parsed = z.object({ projectId: z.string().trim().min(1).max(100).nullable() }).safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Choose a valid Todoist project or select no project.");
    res.json({ preference: await saveMarketingTodoistProjectPreference(userId(req), parsed.data.projectId) });
  } catch (error) { next(error); }
});

const FollowupBody = z.object({
  contactId: z.string().uuid(), campaignId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200), dueAt: dateTime, reminderAt: dateTime.nullable().optional(), notes: z.string().trim().max(2000).optional(),
});
router.post("/followups", async (req, res, next) => {
  try {
    const parsed = FollowupBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Choose a contact, a task title, and a due date.");
    const dueAt = new Date(parsed.data.dueAt);
    if (dueAt.getTime() <= Date.now()) throw new BadRequestError("Choose a future follow-up time.");
    const reminderAt = parsed.data.reminderAt ? new Date(parsed.data.reminderAt) : null;
    if (reminderAt && reminderAt > dueAt) throw new BadRequestError("Choose a reminder at or before the follow-up time.");
    res.json({ followup: await createMarketingFollowup(userId(req), { ...parsed.data, dueAt, reminderAt }) });
  } catch (error) { next(error); }
});

router.patch("/followups/:id", async (req, res, next) => {
  try {
    const parsed = z.object({ dueAt: dateTime }).safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Choose a valid due date.");
    const dueAt = new Date(parsed.data.dueAt);
    if (dueAt.getTime() <= Date.now()) throw new BadRequestError("Choose a future follow-up time.");
    await rescheduleMarketingFollowup(userId(req), req.params.id, dueAt);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.patch("/followups/:id/reminder", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const parsed = z.object({ reminderAt: dateTime.nullable() }).safeParse(req.body ?? {});
    if (!id.success || !parsed.success) throw new BadRequestError("Choose a valid reminder time or turn reminders off.");
    const reminderAt = parsed.data.reminderAt ? new Date(parsed.data.reminderAt) : null;
    await setMarketingFollowupReminder(userId(req), id.data, reminderAt);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post("/followups/:id/reminders/:channel/retry", marketingTodoistSyncRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const channel = z.enum(["push", "email"]).safeParse(req.params.channel);
    const body = z.object({ confirmedNotSent: z.boolean().optional().default(false) }).safeParse(req.body ?? {});
    if (!id.success || !channel.success || !body.success) throw new BadRequestError("Choose a valid reminder channel and retry confirmation.");
    await requestMarketingReminderDeliveryRetry(userId(req), id.data, channel.data, body.data.confirmedNotSent);
    res.json({ queued: true });
  } catch (error) { next(error); }
});

router.post("/followups/:id/complete", async (req, res, next) => {
  try { await completeMarketingFollowup(userId(req), req.params.id); res.json({ ok: true }); }
  catch (error) { next(error); }
});
router.post("/followups/:id/cancel", async (req, res, next) => {
  try { await cancelMarketingFollowup(userId(req), req.params.id); res.json({ ok: true }); }
  catch (error) { next(error); }
});

router.post("/followups/:id/todoist", async (req, res, next) => {
  try {
    const result = await exportMarketingFollowupToTodoist(userId(req), req.params.id);
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) { next(error); }
});

router.post("/followups/:id/todoist-sync", marketingTodoistSyncRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z.object({ confirmed: z.literal(true) }).safeParse(req.body ?? {});
    if (!id.success || !body.success) throw new BadRequestError("Confirm that you want to check this follow-up against Todoist.");
    res.json({ result: await syncMarketingFollowupFromTodoist(userId(req), id.data) });
  } catch (error) { next(error); }
});

router.get("/content", async (req, res, next) => {
  try {
    const from = typeof req.query.from === "string" ? dateTime.safeParse(req.query.from) : undefined;
    const to = typeof req.query.to === "string" ? dateTime.safeParse(req.query.to) : undefined;
    if (from && !from.success || to && !to.success) throw new BadRequestError("Calendar range must use ISO datetimes.");
    res.json({ items: await listMarketingContent(userId(req), from?.success ? new Date(from.data) : undefined, to?.success ? new Date(to.data) : undefined) });
  } catch (error) { next(error); }
});

router.get("/content/provider-checks", async (req, res, next) => {
  try { res.json({ snapshots: await listLatestMarketingPostMetrics(userId(req)) }); }
  catch (error) { next(error); }
});

const PostMonitorProvider = z.enum(["facebook", "instagram", "linkedin"]);
router.get("/content/post-monitoring", async (req, res, next) => {
  try { res.json({ preference: await getMarketingPostMonitoringPreference(userId(req)) }); }
  catch (error) { next(error); }
});

router.put("/content/post-monitoring", marketingAnalyticsTargetsRateLimit, async (req, res, next) => {
  try {
    const parsed = z.object({
      enabled: z.boolean(), providers: z.array(PostMonitorProvider).max(3),
    }).refine((value) => new Set(value.providers).size === value.providers.length)
      .safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Choose supported social providers for automatic post checks.");
    const preference = await saveMarketingPostMonitoringPreference(userId(req), {
      enabled: parsed.data.enabled, providers: parsed.data.providers as MarketingPostProvider[],
    });
    res.json({ preference });
  } catch (error) { next(error); }
});

const PublishProvider = z.enum(["facebook", "instagram", "linkedin"]);
router.get("/content/publish-targets", async (req, res, next) => {
  try {
    const provider = PublishProvider.safeParse(req.query.provider);
    if (!provider.success) throw new BadRequestError("Choose Facebook, Instagram, or LinkedIn as the publish destination.");
    res.json({ targets: await getMarketingPublishTargets(userId(req), provider.data) });
  } catch (error) { next(error); }
});

router.post("/content/:id/publish", marketingPublishRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z.object({ confirmed: z.literal(true), provider: PublishProvider, targetId: z.string().trim().min(1).max(200) }).safeParse(req.body ?? {});
    if (!id.success || !body.success) throw new BadRequestError("Review the content and destination, then explicitly confirm publishing.");
    const item = await publishMarketingContent(userId(req), id.data, body.data.provider as MarketingPublishProvider, body.data.targetId);
    res.json({ item });
  } catch (error) { next(error); }
});

router.post("/content/:id/schedule-publish", marketingPublishRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z.object({
      confirmed: z.literal(true), provider: PublishProvider, targetId: z.string().trim().min(1).max(200), scheduledAt: dateTime,
    }).safeParse(req.body ?? {});
    if (!id.success || !body.success) throw new BadRequestError("Review the approved post, destination, and publish time, then explicitly confirm scheduling.");
    const item = await scheduleMarketingSocialPublish(
      userId(req), id.data, body.data.provider as MarketingPublishProvider, body.data.targetId, new Date(body.data.scheduledAt),
    );
    res.json({ item });
  } catch (error) { next(error); }
});

router.post("/content/:id/unschedule-publish", marketingPublishRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z.object({ confirmed: z.literal(true) }).safeParse(req.body ?? {});
    if (!id.success || !body.success) throw new BadRequestError("Confirm that you want to remove this waiting automatic publish schedule.");
    res.json({ item: await unscheduleMarketingSocialPublish(userId(req), id.data) });
  } catch (error) { next(error); }
});

router.post("/content/:id/provider-check", marketingPostStatusRateLimit, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new BadRequestError("Choose a valid published content item.");
    res.json({ snapshot: await checkMarketingPublishedPost(userId(req), id.data) });
  } catch (error) { next(error); }
});

router.get("/content/:id/provider-checks", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new BadRequestError("Choose a valid content item.");
    res.json({ snapshots: await getMarketingPostMetricsHistory(userId(req), id.data) });
  } catch (error) { next(error); }
});

router.post("/content/:id/publish-retry", async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z.object({ confirmedNoPost: z.literal(true) }).safeParse(req.body ?? {});
    if (!id.success || !body.success) throw new BadRequestError("Confirm you checked the provider account and the post does not exist before retrying.");
    res.json({ item: await requeueMarketingContentPublish(userId(req), id.data, body.data.confirmedNoPost) });
  } catch (error) { next(error); }
});

router.get("/content/:id/history", async (req, res, next) => {
  try {
    const user = userId(req);
    const [events, revisions] = await Promise.all([
      listMarketingApprovalHistory(user, "content", req.params.id),
      listMarketingContentRevisions(user, req.params.id),
    ]);
    res.json({ events, revisions });
  }
  catch (error) { next(error); }
});

const CreateBody = z.object({
  campaignId: z.string().uuid().optional(), title: z.string().trim().min(1).max(200), channel: Channels,
  body: z.string().max(30000).optional(), assetUrl: z.string().url().max(2000).optional(), scheduledAt: dateTime.optional(),
});
router.post("/content", async (req, res, next) => {
  try {
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("A title and supported channel are required.");
    const item = await createMarketingContent(userId(req), {
      ...parsed.data, channel: parsed.data.channel as MarketingChannel,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : undefined,
    });
    res.json({ item });
  } catch (error) { next(error); }
});

const PatchBody = z.object({
  title: z.string().trim().min(1).max(200).optional(), channel: Channels.optional(), body: z.string().max(30000).optional(),
  assetUrl: z.string().url().max(2000).nullable().optional(), scheduledAt: dateTime.nullable().optional(),
}).refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: "Choose at least one field to update." });
router.patch("/content/:id", async (req, res, next) => {
  try {
    const parsed = PatchBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid content update.");
    if (parsed.data.scheduledAt && new Date(parsed.data.scheduledAt).getTime() <= Date.now()) {
      throw new BadRequestError("Choose a future calendar time.");
    }
    const item = await updateMarketingContent(userId(req), req.params.id, {
      ...parsed.data, channel: parsed.data.channel as MarketingChannel | undefined,
      scheduledAt: parsed.data.scheduledAt === undefined ? undefined : parsed.data.scheduledAt === null ? null : new Date(parsed.data.scheduledAt),
    });
    res.json({ item });
  } catch (error) { next(error); }
});

router.post("/content/:id/submit", async (req, res, next) => {
  try { res.json({ item: await submitMarketingContent(userId(req), req.params.id) }); }
  catch (error) { next(error); }
});
router.post("/content/:id/approve", async (req, res, next) => {
  try {
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : undefined;
    res.json({ item: await approveMarketingContent(userId(req), req.params.id, note) });
  } catch (error) { next(error); }
});
router.post("/content/:id/plan", async (req, res, next) => {
  try {
    const parsed = z.object({ scheduledAt: dateTime }).safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("scheduledAt must be an ISO datetime.");
    const scheduledAt = new Date(parsed.data.scheduledAt);
    if (scheduledAt.getTime() <= Date.now()) throw new BadRequestError("Choose a future calendar time.");
    res.json({ item: await planMarketingContent(userId(req), req.params.id, scheduledAt) });
  } catch (error) { next(error); }
});
router.post("/content/:id/published", async (req, res, next) => {
  try {
    const parsed = z.object({ provider: Channels, providerItemId: z.string().max(1000).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Choose the provider where the content was published.");
    res.json({ item: await markMarketingContentPublished(userId(req), req.params.id, parsed.data.provider, parsed.data.providerItemId) });
  } catch (error) { next(error); }
});
router.post("/content/:id/completed", async (req, res, next) => {
  try {
    const parsed = z.object({ provider: Channels, providerItemId: z.string().max(1000).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Choose the channel for this completed activity.");
    res.json({ item: await completeMarketingContent(userId(req), req.params.id, parsed.data.provider, parsed.data.providerItemId) });
  } catch (error) { next(error); }
});
router.post("/content/:id/cancel", async (req, res, next) => {
  try { res.json({ item: await cancelMarketingContent(userId(req), req.params.id) }); }
  catch (error) { next(error); }
});

export default router;
