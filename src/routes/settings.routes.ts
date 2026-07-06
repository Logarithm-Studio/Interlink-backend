/** /api/v1/settings — user preferences (mail provider switch, …). */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { getMailProvider, setMailProvider, listActiveMailbox } from "../services/settings/mailPreference.service";

const router = Router();
router.use(authMiddleware as never);

router.get("/mail-provider", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ provider: await getMailProvider((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

const MailProviderBody = z.object({ provider: z.enum(["gmail", "outlook"]) });

router.patch("/mail-provider", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = MailProviderBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("provider must be 'gmail' or 'outlook'.");
    await setMailProvider((req as AuthenticatedRequest).user.id, parsed.data.provider);
    res.json({ ok: true, provider: parsed.data.provider });
  } catch (err) {
    next(err);
  }
});

// The active mailbox (Gmail or Outlook) in a provider-agnostic shape — for the Mails tab.
router.get("/mailbox", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listActiveMailbox((req as AuthenticatedRequest).user.id));
  } catch (err) {
    next(err);
  }
});

export default router;
