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
import {
  listDeals, getDealDetail, createDeal, updateDeal,
  listContacts, getContact, createContact, updateContact,
  listContracts, listReps, createRep,
  getOverview, enrichLead, generateContract, markContractSigned,
  routeLead, processMeetingTranscript, getOrCreateFormKey, captureInboundLead,
  type DealStage,
} from "../services/professional/sales/sales.service";

const router = Router();

// ─── Public inbound web-form intake (no auth) ──────────────────────────────────
const InboundBody = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  company: z.string().max(200).optional(),
  message: z.string().max(4000).optional(),
});
router.post("/inbound/:formKey", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = InboundBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("name is required.");
    const result = await captureInboundLead(req.params.formKey, parsed.data);
    if (!result.ok) throw new NotFoundError("Unknown form.");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Everything else requires auth ─────────────────────────────────────────────
router.use(authMiddleware as never);

function uid(req: Request): string {
  return (req as AuthenticatedRequest).user.id;
}
function appUser(req: Request) {
  return (req as AuthenticatedRequest).user;
}

router.get("/overview", async (req, res, next) => {
  try { res.json(await getOverview(uid(req))); } catch (err) { next(err); }
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

export default router;
