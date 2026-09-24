/**
 * /api/v1/sales/* — bespoke Sales & Business Development workspace (mirrors the
 * accountant surface). Self-contained CRM + the 5 PRD workflows. The AI Command
 * Center (/accountant/assistant/command) and /professional/automations are reused
 * as-is for chat + autonomy.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError, NotFoundError } from "../utils/errors";
import { marketingInboundFormRateLimit } from "../middleware/rateLimit";
import { getMarketingTurnstileConfig, validateMarketingTurnstile } from "../services/professional/marketing/turnstile.service";
import { listMarketingApprovalHistory } from "../services/professional/marketing/content.service";
import { MARKETING_GOAL_METRICS } from "../services/professional/marketing/campaign-goals.model";
import {
  listDeals, getDealDetail, createDeal, updateDeal,
  listContacts, getContact, createContact, updateContact,
  listMarketingConsentEvents,
  listContracts, listReps, createRep,
  getOverview, enrichLead, generateContract, markContractSigned,
  routeLead, processMeetingTranscript, getOrCreateFormKey, captureInboundLead,
  listMarketingCampaigns, getMarketingCampaignLeads, createMarketingCampaign, updateMarketingCampaign, sendMarketingCampaign,
  getMarketingProviderAudiences, createMarketingProviderDraft, reconcileMarketingProviderDraft, scheduleMarketingCampaign,
  unscheduleMarketingCampaign, syncMarketingCampaign,
  getMarketingLeadFormSettings, getMarketingLeadFormSettingsByKey, saveMarketingLeadFormSettings,
  type DealStage,
} from "../services/professional/sales/sales.service";

const router = Router();

// ─── Public inbound web-form intake (no auth) ──────────────────────────────────
const InboundBody = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  company: z.string().max(200).optional(),
  message: z.string().max(4000).optional(),
  campaignId: z.string().uuid().optional(),
  activationId: z.string().uuid().optional(),
  utmSource: z.string().max(200).optional(), utmMedium: z.string().max(200).optional(),
  utmCampaign: z.string().max(300).optional(), utmContent: z.string().max(300).optional(),
  landingPage: z.string().url().max(2000).optional(), referrer: z.string().url().max(2000).optional(),
  website: z.string().max(500).optional(),
  "cf-turnstile-response": z.string().max(2048).optional(),
  marketingOptIn: z.boolean().optional(),
  marketingConsentText: z.string().max(1000).optional(),
}).superRefine((data, context) => {
  if (data.marketingOptIn && !data.email) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["email"], message: "Email is required for marketing permission." });
  }
});
function escapeHtmlAttribute(value: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

router.get("/inbound/:formKey", (req, res, next) => {
  void getMarketingLeadFormSettingsByKey(req.params.formKey).then((formSettings) => {
  if (!formSettings) { res.status(404).type("text").send("This lead form could not be found."); return; }
  const turnstile = getMarketingTurnstileConfig();
  if (turnstile.misconfigured) {
    res.status(503).type("text").send("This lead form is temporarily unavailable.");
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const cspSources = [
    "default-src 'none'", "style-src 'unsafe-inline'",
    `script-src 'unsafe-inline'${turnstile.enabled ? " https://challenges.cloudflare.com" : ""}`,
    "connect-src 'self'", `frame-src${turnstile.enabled ? " https://challenges.cloudflare.com" : " 'none'"}`,
    "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'",
  ];
  res.setHeader("Content-Security-Policy", cspSources.join("; "));
  const widgetScript = turnstile.enabled
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : "";
  const widget = turnstile.enabled && turnstile.siteKey
    ? `<div class="cf-turnstile" data-sitekey="${escapeHtmlAttribute(turnstile.siteKey)}"></div>`
    : "";
  const brandName = escapeHtmlAttribute(formSettings.brandName);
  const headline = escapeHtmlAttribute(formSettings.headline);
  const description = escapeHtmlAttribute(formSettings.description);
  const accentColor = /^#[\da-f]{6}$/i.test(formSettings.accentColor) ? formSettings.accentColor : "#4545d6";
  const brandMarkup = brandName ? `<div class="brand">${brandName}</div>` : "";
  const privacyMarkup = formSettings.privacyPolicyUrl
    ? `<a class="privacy" href="${escapeHtmlAttribute(formSettings.privacyPolicyUrl)}" target="_blank" rel="noopener noreferrer">Privacy policy</a>`
    : "";
  const consentMarkup = formSettings.marketingConsentText
    ? `<label class="consent" for="marketing-opt-in"><input id="marketing-opt-in" name="marketingOptIn" type="checkbox">${escapeHtmlAttribute(formSettings.marketingConsentText)}</label><input type="hidden" name="marketingConsentText" value="${escapeHtmlAttribute(formSettings.marketingConsentText)}">`
    : "";
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${brandName || "Contact us"}</title>${widgetScript}
<style>body{margin:0;background:#f5f6fa;color:#191a24;font:16px system-ui,sans-serif}.wrap{max-width:520px;margin:8vh auto;padding:24px}.card{background:white;border:1px solid #e3e5ec;border-radius:18px;padding:28px;box-shadow:0 8px 32px #191a2410}.brand{font-size:12px;font-weight:700;color:${accentColor};margin-bottom:8px}h1{font-size:24px;margin:0 0 8px}p{color:#676979;line-height:1.5;margin:0 0 22px}label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}input,textarea{box-sizing:border-box;width:100%;border:1px solid #d9dbe5;border-radius:10px;padding:12px;font:inherit}textarea{min-height:110px;resize:vertical}.consent{display:flex;align-items:flex-start;gap:8px;font-weight:400;line-height:1.45}.consent input{width:auto;margin-top:2px}.privacy{display:inline-block;margin-top:12px;color:${accentColor};font-size:13px}button{width:100%;margin-top:18px;border:0;border-radius:10px;background:${accentColor};color:white;font:600 15px system-ui;padding:14px;cursor:pointer}button:disabled{opacity:.6}#status{min-height:24px;margin:14px 0 0;font-size:14px}</style></head>
<body><main class="wrap"><section class="card">${brandMarkup}<h1>${headline}</h1><p>${description}</p>
<form id="lead-form"><label for="name">Name *</label><input id="name" name="name" required maxlength="200" autocomplete="name"><label for="email">Work email</label><input id="email" name="email" type="email" maxlength="254" autocomplete="email"><label for="company">Company</label><input id="company" name="company" maxlength="200" autocomplete="organization"><label for="message">How can we help?</label><textarea id="message" name="message" maxlength="4000"></textarea>${consentMarkup}${privacyMarkup}${widget}<div aria-hidden="true" style="position:absolute;left:-10000px"><label for="website">Leave this blank</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div><button id="submit" type="submit">Send inquiry</button><div id="status" role="status" aria-live="polite"></div></form>
<script>const form=document.getElementById('lead-form'),status=document.getElementById('status'),button=document.getElementById('submit'),params=new URLSearchParams(location.search);form.addEventListener('submit',async event=>{event.preventDefault();const consentBox=document.getElementById('marketing-opt-in'),emailField=document.getElementById('email');if(consentBox&&consentBox.checked&&!emailField.value.trim()){status.textContent='Enter your email address to give marketing email permission.';emailField.focus();return}button.disabled=true;status.textContent='Sending…';const data=Object.fromEntries(new FormData(form));if(consentBox)data.marketingOptIn=consentBox.checked;for(const [query,key] of [['campaignId','campaignId'],['activationId','activationId'],['utm_source','utmSource'],['utm_medium','utmMedium'],['utm_campaign','utmCampaign'],['utm_content','utmContent']]){const value=params.get(query);if(value)data[key]=value}data.landingPage=location.href.split('?')[0];if(document.referrer)data.referrer=document.referrer;for(const key of ['email','company','message'])if(!data[key])delete data[key];try{const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(!response.ok)throw new Error('Could not send your inquiry. Please try again later.');form.reset();status.textContent='Thank you. Your inquiry was sent.'}catch(error){status.textContent=error.message||'Could not send your inquiry. Please try again later.'}finally{if(window.turnstile)window.turnstile.reset();button.disabled=false}});</script></section></main></body></html>`);
  }).catch(next);
});
router.post("/inbound/:formKey", marketingInboundFormRateLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = InboundBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Check the required form fields.");
    if (parsed.data.website?.trim()) { res.json({ ok: true }); return; }
    const { "cf-turnstile-response": challengeToken, ...lead } = parsed.data;
    if (lead.marketingOptIn && !lead.email) throw new BadRequestError("Enter an email address to give marketing email permission.");
    await validateMarketingTurnstile(challengeToken, req.hostname);
    const result = await captureInboundLead(req.params.formKey, lead);
    if (!result.ok) throw new NotFoundError("Unknown form.");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Everything else requires auth ─────────────────────────────────────────────
router.use(authMiddleware as never);
// Every :id here is a uuid column; reject malformed ids before Postgres turns them into a 500.
router.param("id", (_req, _res, next, id: string) => {
  next(z.string().uuid().safeParse(id).success ? undefined : new BadRequestError("Choose a valid item."));
});

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}
function appUser(req: Request) {
  return (req as AuthenticatedRequest).user;
}

router.get("/overview", async (req, res, next) => {
  try { res.json(await getOverview(uid(req))); } catch (err) { next(err); }
});

router.get("/campaigns", async (req, res, next) => {
  try { res.json({ campaigns: await listMarketingCampaigns(uid(req)) }); } catch (err) { next(err); }
});

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const CampaignBody = z.object({
  topic: z.string().trim().min(1).max(300), audience: z.string().trim().max(500).optional(),
  objective: z.string().trim().max(500).optional(), offer: z.string().trim().max(1000).optional(),
  successMetric: z.string().trim().max(500).optional(),
  goalMetric: z.enum(MARKETING_GOAL_METRICS).optional(),
  goalTarget: z.number().int().min(1).max(1_000_000_000).optional(),
  goalCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  channels: z.array(z.enum(["email", "instagram", "facebook", "linkedin", "youtube", "blog", "landing_page", "search", "ad", "influencer", "event", "other"])).min(1).max(12).optional(),
  startDate: DateOnly.optional(), endDate: DateOnly.optional(),
  budgetCents: z.number().int().min(0).max(1_000_000_000).optional(),
}).refine((data) => !data.startDate || !data.endDate || data.endDate >= data.startDate, { message: "endDate must be on or after startDate." })
  .refine((data) => {
    if (!data.goalMetric) return data.goalTarget === undefined && data.goalCurrency === undefined;
    if (data.goalTarget === undefined) return false;
    return data.goalMetric === "closed_won_value" ? Boolean(data.goalCurrency) : data.goalCurrency === undefined;
  }, { message: "Choose a target and, for closed-won value, its three-letter currency." });
router.post("/campaigns", async (req, res, next) => {
  try {
    const parsed = CampaignBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("topic is required.");
    res.json({ campaign: await createMarketingCampaign(uid(req), {
      ...parsed.data, topic: parsed.data.topic.trim(), audience: parsed.data.audience?.trim(),
      objective: parsed.data.objective?.trim(), offer: parsed.data.offer?.trim(), successMetric: parsed.data.successMetric?.trim(),
    }) });
  } catch (err) { next(err); }
});

const CampaignPatch = z.object({
  subject: z.string().trim().min(1).max(300).optional(),
  body: z.string().trim().min(1).max(20000).optional(),
  audience: z.string().trim().max(200).nullable().optional(),
  goalMetric: z.enum(MARKETING_GOAL_METRICS).nullable().optional(),
  goalTarget: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  goalCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
}).refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: "Choose at least one campaign field to update." })
  .refine((patch) => {
    const touched = patch.goalMetric !== undefined || patch.goalTarget !== undefined || patch.goalCurrency !== undefined;
    if (!touched) return true;
    if (patch.goalMetric === undefined || patch.goalTarget === undefined || patch.goalCurrency === undefined) return false;
    if (patch.goalMetric === null) return patch.goalTarget === null && patch.goalCurrency === null;
    if (patch.goalTarget === null) return false;
    return patch.goalMetric === "closed_won_value" ? Boolean(patch.goalCurrency) : patch.goalCurrency === null;
  }, { message: "Send a complete goal configuration or clear all goal fields." });
router.patch("/campaigns/:id", async (req, res, next) => {
  try {
    const parsed = CampaignPatch.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid campaign update.");
    const campaign = await updateMarketingCampaign(uid(req), req.params.id, parsed.data);
    if (!campaign) throw new NotFoundError("Campaign not found or no longer editable.");
    res.json({ campaign });
  } catch (err) { next(err); }
});

router.get("/campaigns/mailchimp/audiences", async (req, res, next) => {
  try { res.json({ audiences: await getMarketingProviderAudiences(uid(req)) }); } catch (err) { next(err); }
});
router.get("/campaigns/:id/history", async (req, res, next) => {
  try { res.json({ events: await listMarketingApprovalHistory(uid(req), "campaign", req.params.id) }); } catch (err) { next(err); }
});
router.get("/campaigns/:id/leads", async (req, res, next) => {
  try { res.json(await getMarketingCampaignLeads(uid(req), req.params.id)); } catch (err) { next(err); }
});

const MailchimpDraftBody = z.object({
  audienceId: z.string().min(1).max(120),
  fromName: z.string().min(1).max(100),
  replyTo: z.string().email().max(254),
});
router.post("/campaigns/:id/provider-draft", async (req, res, next) => {
  try {
    const parsed = MailchimpDraftBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Choose a Mailchimp audience and provide sender details.");
    res.json({ campaign: await createMarketingProviderDraft(uid(req), req.params.id, parsed.data) });
  } catch (err) { next(err); }
});

router.post("/campaigns/:id/reconcile", async (req, res, next) => {
  try {
    const parsed = z.object({ providerCampaignId: z.string().min(1).max(120) }).safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Provide the Mailchimp campaign ID to recover.");
    res.json({ campaign: await reconcileMarketingProviderDraft(uid(req), req.params.id, parsed.data.providerCampaignId) });
  } catch (err) { next(err); }
});

const ScheduleBody = z.object({ scheduledAt: z.string().datetime() });
router.post("/campaigns/:id/schedule", async (req, res, next) => {
  try {
    const parsed = ScheduleBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("scheduledAt must be an ISO datetime.");
    res.json({ campaign: await scheduleMarketingCampaign(uid(req), req.params.id, new Date(parsed.data.scheduledAt)) });
  } catch (err) { next(err); }
});

router.post("/campaigns/:id/unschedule", async (req, res, next) => {
  try { res.json({ campaign: await unscheduleMarketingCampaign(uid(req), req.params.id) }); } catch (err) { next(err); }
});

router.post("/campaigns/:id/sync", async (req, res, next) => {
  try { res.json({ campaign: await syncMarketingCampaign(uid(req), req.params.id) }); } catch (err) { next(err); }
});

router.post("/campaigns/:id/send", async (req, res, next) => {
  try { res.json(await sendMarketingCampaign(appUser(req), req.params.id)); } catch (err) { next(err); }
});

router.get("/deals", async (req, res, next) => {
  try { res.json({ deals: await listDeals(uid(req)) }); } catch (err) { next(err); }
});

router.get("/deals/:id", async (req, res, next) => {
  try {
    const detail = await getDealDetail(uid(req), req.params.id);
    if (!detail) throw new NotFoundError("Deal not found.");
    res.json(detail);
  } catch (err) { next(err); }
});

const DealBody = z.object({
  title: z.string().min(1).max(200),
  contactName: z.string().max(200).optional(),
  company: z.string().max(200).optional(),
  amountCents: z.number().int().nonnegative().optional(),
  stage: z.string().optional(),
});
router.post("/deals", async (req, res, next) => {
  try {
    const p = DealBody.safeParse(req.body ?? {});
    if (!p.success) throw new BadRequestError("title is required.");
    res.json({ deal: await createDeal(uid(req), { ...p.data, stage: p.data.stage as DealStage | undefined }) });
  } catch (err) { next(err); }
});

const DealPatch = z.object({
  stage: z.string().optional(),
  amountCents: z.number().int().nonnegative().optional(),
  notes: z.string().max(4000).optional(),
  contactName: z.string().max(200).optional(),
});
router.patch("/deals/:id", async (req, res, next) => {
  try {
    const p = DealPatch.safeParse(req.body ?? {});
    if (!p.success) throw new BadRequestError("Invalid patch.");
    const deal = await updateDeal(uid(req), req.params.id, { ...p.data, stage: p.data.stage as DealStage | undefined });
    if (!deal) throw new NotFoundError("Deal not found.");
    res.json({ deal });
  } catch (err) { next(err); }
});

router.post("/deals/:id/contract", async (req, res, next) => {
  try { res.json(await generateContract(appUser(req), req.params.id)); } catch (err) { next(err); }
});

router.post("/deals/:id/sign", async (req, res, next) => {
  try { res.json(await markContractSigned(appUser(req), req.params.id)); } catch (err) { next(err); }
});

const MeetingBody = z.object({ transcript: z.string().min(1).max(20000) });
router.post("/deals/:id/meeting-followup", async (req, res, next) => {
  try {
    const p = MeetingBody.safeParse(req.body ?? {});
    if (!p.success) throw new BadRequestError("transcript is required.");
    res.json(await processMeetingTranscript(appUser(req), req.params.id, p.data.transcript));
  } catch (err) { next(err); }
});

router.get("/contacts", async (req, res, next) => {
  try { res.json({ contacts: await listContacts(uid(req)) }); } catch (err) { next(err); }
});

const EnrichBody = z.object({ emailText: z.string().min(1).max(8000) });
router.post("/contacts/enrich", async (req, res, next) => {
  try {
    const p = EnrichBody.safeParse(req.body ?? {});
    if (!p.success) throw new BadRequestError("emailText is required.");
    const { contact, isFallback } = await enrichLead(uid(req), p.data.emailText);
    res.json({ contact, isFallback });
  } catch (err) { next(err); }
});

router.get("/contacts/:id", async (req, res, next) => {
  try {
    const c = await getContact(uid(req), req.params.id);
    if (!c) throw new NotFoundError("Contact not found.");
    res.json({ contact: c });
  } catch (err) { next(err); }
});
const ContactBody = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  company: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  territory: z.string().max(120).optional(),
});
router.post("/contacts", async (req, res, next) => {
  try {
    const p = ContactBody.safeParse(req.body ?? {});
    if (!p.success) throw new BadRequestError("name is required.");
    res.json({ contact: await createContact(uid(req), p.data) });
  } catch (err) { next(err); }
});

const ContactPatch = z.object({
  email: z.string().email().optional(),
  company: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  territory: z.string().max(120).optional(),
  marketingOptIn: z.boolean().optional(),
  marketingOptInSource: z.enum(["website_signup", "imported_crm", "email_request", "event_signup", "other", "user_recorded"]).optional(),
  marketingOptInEvidence: z.string().trim().max(1000).optional(),
}).refine((data) => data.marketingOptIn !== true || Boolean(data.marketingOptInSource && data.marketingOptInEvidence?.trim()), {
  message: "Record where permission came from and add evidence before marking it as recorded.",
});
router.patch("/contacts/:id", async (req, res, next) => {
  try {
    const p = ContactPatch.safeParse(req.body ?? {});
    if (!p.success) throw new BadRequestError("Invalid patch.");
    const contact = await updateContact(uid(req), req.params.id, p.data);
    if (!contact) throw new NotFoundError("Contact not found.");
    res.json({ contact });
  } catch (err) { next(err); }
});
router.get("/contacts/:id/marketing-consent", async (req, res, next) => {
  try { res.json({ events: await listMarketingConsentEvents(uid(req), req.params.id) }); }
  catch (err) { next(err); }
});

router.get("/contracts", async (req, res, next) => {
  try { res.json({ contracts: await listContracts(uid(req)) }); } catch (err) { next(err); }
});

router.get("/reps", async (req, res, next) => {
  try { res.json({ reps: await listReps(uid(req)) }); } catch (err) { next(err); }
});
const RepBody = z.object({ name: z.string().min(1).max(200), email: z.string().email().optional(), territory: z.string().max(120).optional() });
router.post("/reps", async (req, res, next) => {
  try {
    const p = RepBody.safeParse(req.body ?? {});
    if (!p.success) throw new BadRequestError("name is required.");
    res.json({ rep: await createRep(uid(req), p.data) });
  } catch (err) { next(err); }
});

const RouteBody = z.object({ contactName: z.string().min(1) });
router.post("/leads/route", async (req, res, next) => {
  try {
    const p = RouteBody.safeParse(req.body ?? {});
    if (!p.success) throw new BadRequestError("contactName is required.");
    res.json(await routeLead(appUser(req), p.data.contactName));
  } catch (err) { next(err); }
});

router.get("/form-key", async (req, res, next) => {
  try { res.json({ formKey: await getOrCreateFormKey(uid(req)) }); } catch (err) { next(err); }
});

router.get("/inbound-form-settings", async (req, res, next) => {
  try { res.json({ settings: await getMarketingLeadFormSettings(uid(req)) }); }
  catch (err) { next(err); }
});

const MarketingLeadFormSettingsBody = z.object({
  brandName: z.string().trim().max(100),
  headline: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  accentColor: z.string().regex(/^#[\da-fA-F]{6}$/),
  privacyPolicyUrl: z.string().trim().url().max(2000).refine((value) => value.startsWith("https://"), "Use an HTTPS privacy policy URL.").nullable(),
  marketingConsentText: z.string().trim().max(1000).nullable(),
});
router.put("/inbound-form-settings", async (req, res, next) => {
  try {
    const parsed = MarketingLeadFormSettingsBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Check the form copy, HTTPS privacy link, and six-digit accent color.");
    res.json({ settings: await saveMarketingLeadFormSettings(uid(req), parsed.data) });
  } catch (err) { next(err); }
});

export default router;
