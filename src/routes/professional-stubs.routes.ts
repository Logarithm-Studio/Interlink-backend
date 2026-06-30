/**
 * Placeholder routes for professional personas not yet fully implemented.
 * Each stub returns a consistent { persona, status: 'coming_soon', description } response
 * so the app can render a "Coming Soon" card.
 */

import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../middleware/auth";

const router = Router();
router.use(authMiddleware as never);

const PERSONA_DESCRIPTIONS: Record<string, string> = {
  sales: "CRM sync, deal pipeline tracking, follow-up automation, and prospect research via HubSpot.",
  marketing: "Campaign performance, email draft generation, and content calendar via Mailchimp.",
  legal: "Contract drafting, deadline tracking, and document organization via Google Drive.",
  real_estate: "Listing management, showing scheduling, and client follow-ups with Maps integration.",
  healthcare: "Patient scheduling, appointment reminders, and care gap analysis.",
  operations: "Supply chain tracking, vendor management, and SLA monitoring.",
  recruiter: "Job posting automation, candidate pipeline, and interview scheduling.",
  customer_support: "Email ticket categorization, auto-response drafts, and resolution tracking.",
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
