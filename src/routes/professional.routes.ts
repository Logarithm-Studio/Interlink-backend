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
import { importSheet } from "../services/professional/import.service";
import { createContact, createDeal } from "../services/professional/sales/sales.service";
import { createTicket } from "../services/professional/support/support.service";
import { createListing, createLead } from "../services/professional/realestate/realestate.service";
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
    "re_listing", "re_lead", "hr_candidate", "hr_opening",
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
      case "hr_candidate": entity = await createCandidate(user.id, d); break;
      case "hr_opening": entity = await createOpening(user.id, d); break;
    }
    res.json({ entity });
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

export default router;
