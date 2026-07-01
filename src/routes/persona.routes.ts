/**
 * /api/v1/persona  — profession profile management (personal & professional mode).
 * /api/v1/integrations — list / revoke third-party OAuth connections.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { query } from "../config/db";
import { listIntegrationsForUser, revokeIntegration } from "../services/integrations/tokenStore";

const router = Router();
router.use(authMiddleware as never);

// ─── Profession profiles ──────────────────────────────────────────────────────

const PERSONAL_PERSONAS = [
  "developer", "designer", "student", "healthcare_professional",
  "business_professional", "freelancer", "creative", "educator", "general",
];

// The six focus professions (Recruiter merged into HR, Marketing into Sales).
const PROFESSIONAL_PERSONAS = [
  "finance", "sales", "hr", "customer_support", "real_estate", "product_manager",
];

router.get("/persona", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const result = await query<{ mode: string; persona: string; updated_at: Date }>(
      `SELECT mode, persona, updated_at FROM profession_profiles WHERE user_id = $1`,
      [user.id],
    );
    const profiles = Object.fromEntries(result.rows.map((r) => [r.mode, { persona: r.persona, updatedAt: r.updated_at }]));
    res.json({ profiles });
  } catch (err) {
    next(err);
  }
});

const SetPersonaBody = z.object({ persona: z.string().min(1).max(64) });

router.put("/persona/:mode", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const mode = req.params.mode;
    if (!["personal", "professional"].includes(mode)) {
      throw new BadRequestError("mode must be 'personal' or 'professional'");
    }
    const parsed = SetPersonaBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("persona is required.");

    const persona = parsed.data.persona;
    const validPersonas = mode === "personal" ? PERSONAL_PERSONAS : PROFESSIONAL_PERSONAS;
    if (!validPersonas.includes(persona)) {
      throw new BadRequestError(`Unknown persona '${persona}' for mode '${mode}'.`);
    }

    await query(
      `INSERT INTO profession_profiles (user_id, mode, persona)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, mode)
       DO UPDATE SET persona = EXCLUDED.persona, updated_at = now()`,
      [user.id, mode, persona],
    );
    res.json({ ok: true, mode, persona });
  } catch (err) {
    next(err);
  }
});

// ─── Connected integrations ───────────────────────────────────────────────────

router.get("/integrations", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const integrations = await listIntegrationsForUser(user.id);
    res.json({ integrations });
  } catch (err) {
    next(err);
  }
});

router.delete("/integrations/:provider", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    await revokeIntegration(user.id, req.params.provider);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
