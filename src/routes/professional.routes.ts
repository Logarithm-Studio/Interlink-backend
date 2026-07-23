/**
 * /api/v1/professional — shared Professional Work OS surface for the six focus
 * personas: normalized dashboard, one-tap demo seed, manual data-entry, activity
 * feed, and Google-Sheet import. Persona is resolved from profession_profiles.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { query } from "../config/db";
import { getVertical } from "../services/professional/registry";
import { buildDashboard } from "../services/professional/dashboard.service";
import { importSheet, importFile, isImportablePersona } from "../services/professional/import.service";
import {
  getProfessionalAutomations,
  updateProfessionalAutomation,
  type AutonomyLevel,
} from "../services/professional/automations.service";
import {
  approveProfessionalSuggestion,
  runProfessionalAutomationsForUser,
} from "../services/professional/automationRunner";
import { setActivityStatus } from "../services/accountant/activity.service";
import { createContact, createDeal } from "../services/professional/sales/sales.service";
import { createTicket } from "../services/professional/support/support.service";
import { createListing, createLead, createShowing, createLease, listListings } from "../services/professional/realestate/realestate.service";
import {
  publishListing,
  removeListingPhoto,
  unpublishListing,
  uploadListingPhoto,
} from "../services/professional/realestate/listingPhotos.service";
import { createCandidate, createOpening } from "../services/professional/hr/hr.vertical";

const router = Router();
router.use(authMiddleware as never);

async function currentPersona(userId: string): Promise<string> {
  const res = await query<{ persona: string }>(
    `SELECT persona FROM profession_profiles WHERE user_id = $1 AND mode = 'professional' LIMIT 1`,
    [userId],
  );
  return res.rows[0]?.persona ?? "finance";
}

// ─── Dashboard (normalized per-persona payload) ─────────────────────────────
router.get("/dashboard", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const persona = await currentPersona(user.id);
    res.json(await buildDashboard(user.id, persona));
  } catch (err) {
    next(err);
  }
});

// ─── One-tap demo seed ──────────────────────────────────────────────────────
router.post("/seed-demo", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const persona = await currentPersona(user.id);
    const vertical = getVertical(persona);
    if (!vertical?.seedDemo) {
      throw new BadRequestError("No demo data available for this role.");
    }
    res.json(await vertical.seedDemo(user.id));
  } catch (err) {
    next(err);
  }
});

// ─── Manual data entry (typed create per entity) ────────────────────────────
const CreateBody = z.object({
  type: z.enum([
    "sales_contact", "sales_deal", "support_ticket",
    "re_listing", "re_lead", "re_showing", "re_lease", "hr_candidate", "hr_opening",
  ]),
  data: z.record(z.unknown()),
});

router.post("/entities", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("type and data are required.");
    const { type, data } = parsed.data;
    // Data is client-supplied; each create fn validates required fields via SQL
    // NOT NULL. Cast is intentional — see the per-type create signatures.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const d = data as any;

    let entity: unknown;
    switch (type) {
      case "sales_contact": entity = await createContact(user.id, d); break;
      case "sales_deal": entity = await createDeal(user.id, d); break;
      case "support_ticket": entity = await createTicket(user.id, d); break;
      case "re_listing": entity = await createListing(user.id, d); break;
      case "re_lead": entity = await createLead(user.id, d); break;
      case "re_showing": entity = await createShowing(user.id, d); break;
      case "re_lease": entity = await createLease(user.id, d); break;
      case "hr_candidate": entity = await createCandidate(user.id, d); break;
      case "hr_opening": entity = await createOpening(user.id, d); break;
    }
    res.json({ entity });
  } catch (err) {
    next(err);
  }
});

// ─── Real-estate listings: photos + public share page ───────────────────────
// Marketing a property is the part no free listings API can do (syndication needs
// broker/MLS credentials), so an agent hosts it here instead: photos land in Supabase
// Storage and the listing gets a public page to email to buyers.

router.get("/listings", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json({ listings: await listListings(user.id) });
  } catch (err) {
    next(err);
  }
});

const PhotoBody = z.object({
  base64: z.string().min(1),
  contentType: z.string().optional(),
});

router.post("/listings/:id/photos", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = PhotoBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("base64 image data is required.");
    const result = await uploadListingPhoto(user.id, req.params.id, parsed.data.base64, parsed.data.contentType);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete("/listings/:id/photos", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const url = z.string().min(1).safeParse((req.body ?? {}).url);
    if (!url.success) throw new BadRequestError("url of the photo to remove is required.");
    res.json(await removeListingPhoto(user.id, req.params.id, url.data));
  } catch (err) {
    next(err);
  }
});

router.post("/listings/:id/publish", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json(await publishListing(user.id, req.params.id));
  } catch (err) {
    next(err);
  }
});

router.delete("/listings/:id/publish", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    await unpublishListing(user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Autonomy: automations config + activity approve/dismiss + run-now ──────
router.get("/automations", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const persona = await currentPersona(user.id);
    res.json({ automations: await getProfessionalAutomations(user.id, persona) });
  } catch (err) {
    next(err);
  }
});

const AutomationPatch = z.object({
  enabled: z.boolean().optional(),
  autonomy: z.enum(["off", "suggest", "auto"]).optional(),
});
router.put("/automations/:type", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const persona = await currentPersona(user.id);
    const parsed = AutomationPatch.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid automation patch.");
    await updateProfessionalAutomation(user.id, persona, req.params.type, {
      enabled: parsed.data.enabled,
      autonomy: parsed.data.autonomy as AutonomyLevel | undefined,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/automations/run-now", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const persona = await currentPersona(user.id);
    res.json(await runProfessionalAutomationsForUser(user, persona));
  } catch (err) {
    next(err);
  }
});

router.post("/activity/:id/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json(await approveProfessionalSuggestion(user, req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post("/activity/:id/dismiss", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    await setActivityStatus(user.id, req.params.id, "dismissed");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Direct entity action (tapped from the dashboard, no AI round-trip) ─────
const ActionBody = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});
router.post("/action", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const persona = await currentPersona(user.id);
    const vertical = getVertical(persona);
    if (!vertical) throw new BadRequestError("No actions available for this role.");
    const parsed = ActionBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("name is required.");
    res.json(await vertical.executeTool(user, parsed.data.name, parsed.data.args ?? {}));
  } catch (err) {
    next(err);
  }
});

// ─── Google-Sheet import ────────────────────────────────────────────────────
const ImportBody = z.object({ spreadsheetId: z.string().min(1), range: z.string().optional() });

router.post("/import/sheet", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const persona = await currentPersona(user.id);
    const parsed = ImportBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("spreadsheetId is required.");
    res.json(await importSheet(user.id, persona, parsed.data.spreadsheetId, parsed.data.range));
  } catch (err) {
    next(err);
  }
});

// ─── Direct file import (attached .xlsx/.xls/.csv, base64 — no Google Drive) ──
// Same base64-in-JSON convention as the accountant/personal attachment routes.
const ImportFileBody = z.object({
  fileBase64: z.string().min(1),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
});

router.post("/import/file", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const persona = await currentPersona(user.id);
    if (!isImportablePersona(persona)) {
      throw new BadRequestError(
        "Importing a file into the book isn't supported for this role yet. Switch to Sales, Support, Real Estate, or HR — or attach the file to the assistant to analyze it.",
      );
    }
    const parsed = ImportFileBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("fileBase64 is required.");
    res.json(await importFile(user.id, persona, parsed.data.fileBase64, parsed.data.fileName));
  } catch (err) {
    next(err);
  }
});

export default router;
