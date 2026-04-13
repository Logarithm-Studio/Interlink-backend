/**
 * Reminder planning routes.
 *
 * The mobile app schedules *local* notifications (expo-notifications).  This
 * endpoint simply computes, for every upcoming event in the next 24 hours,
 * the exact `notifyAt` timestamp the device should use — accounting for the
 * user's current location and driving ETA to the event venue.
 *
 * The device calls this:
 *   • on app foreground / login,
 *   • when its location changes significantly,
 *   • every ~15 minutes while foregrounded.
 *
 * It then cancels any previously-scheduled reminders and re-schedules using
 * the fresh plans returned here.
 */

import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { computeReminders } from "../services/notifications/reminderPlanner.service";

const router = Router();

router.use(authMiddleware as never);

const ComputeSchema = z.object({
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .nullable()
    .optional(),
  horizonHours: z.number().int().min(1).max(72).optional(),
});

// POST /api/v1/reminders/compute
router.post("/compute", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ComputeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues.map((i) => i.message).join(", "),
      );
    }

    const { plans, leadMinutes } = await computeReminders({
      userId: user.id,
      origin: parsed.data.location ?? null,
      horizonHours: parsed.data.horizonHours,
    });

    res.json({
      leadMinutes,
      computedAt: new Date().toISOString(),
      count: plans.length,
      reminders: plans,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
