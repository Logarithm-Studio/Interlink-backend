/** /api/v1/fitness — Google Fitness REST API proxy */

import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { getDailySummary, getWeeklySummary } from "../services/fitness/fitness.service";

const router = Router();
router.use(authMiddleware as never);

router.get("/summary", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getDailySummary((req as AuthenticatedRequest).user.id));
  } catch (err) {
    next(err);
  }
});

router.get("/weekly", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ days: await getWeeklySummary((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

export default router;
