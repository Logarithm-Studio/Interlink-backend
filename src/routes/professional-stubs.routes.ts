/**
 * Placeholder routes for professional personas not yet fully implemented.
 * Each stub returns a consistent { persona, status: 'coming_soon', description } response
 * so the app can render a "Coming Soon" card.
 */

import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../middleware/auth";

const router = Router();
router.use(authMiddleware as never);

// Only genuinely-unbuilt personas belong here. Finance, Sales, Customer Support,
// Real Estate, HR, and Product Manager are all live (see services/professional/registry
// + the bespoke finance/sales/pm paths) and must NOT be reported as "coming_soon".
// Marketing folds into Sales and Recruiter folds into HR, so they aren't separate personas.
const PERSONA_DESCRIPTIONS: Record<string, string> = {
  legal: "Contract drafting, deadline tracking, and document organization via Google Drive.",
  healthcare: "Patient scheduling, appointment reminders, and care gap analysis.",
  operations: "Supply chain tracking, vendor management, and SLA monitoring.",
};

router.get("/:persona/status", (req: Request, res: Response, next: NextFunction) => {
  try {
    const persona = req.params.persona;
    const description = PERSONA_DESCRIPTIONS[persona];
    if (!description) {
      res.status(404).json({ error: "Unknown persona" });
      return;
    }
    res.json({ persona, status: "coming_soon", description });
  } catch (err) {
    next(err);
  }
});

export default router;
