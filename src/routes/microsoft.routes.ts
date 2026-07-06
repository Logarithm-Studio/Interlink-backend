/** /api/v1/microsoft — Microsoft Graph OAuth + Outlook/Teams/OneDrive proxy */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { createOAuthState, consumeOAuthState } from "../services/oauth-state.service";
import { oauthRateLimit } from "../middleware/rateLimit";
import { appRedirect } from "../services/integrations/oauthAppRedirect";
import {
  buildAuthUrl,
  exchangeCode,
  listOutlookMessages,
  listOutlookEvents,
  listTeamsChats,
  listOneDriveFiles,
} from "../services/microsoft/microsoft.service";

const router = Router();

// Public OAuth callback (no JWT — user resolved from single-use state token).
router.get("/callback", oauthRateLimit, async (req: Request, res: Response) => {
  try {
    const error = req.query.error ? String(req.query.error) : undefined;
    if (error) return res.redirect(302, appRedirect("microsoft", "error", error));

    const code = req.query.code ? String(req.query.code) : "";
    const state = req.query.state ? String(req.query.state) : "";
    if (!code || !state) return res.redirect(302, appRedirect("microsoft", "error", "missing_code_or_state"));

    const payload = await consumeOAuthState(state);
    if (!payload) return res.redirect(302, appRedirect("microsoft", "error", "invalid_state"));

    await exchangeCode(payload.userId, code);
    return res.redirect(302, appRedirect("microsoft", "success"));
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 80) : "exchange_failed";
    return res.redirect(302, appRedirect("microsoft", "error", detail));
  }
});

router.use(authMiddleware as never);

router.get("/auth/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const state = await createOAuthState(user.id, "microsoft");
    res.json({ url: buildAuthUrl(state) });
  } catch (err) {
    next(err);
  }
});

router.post("/auth/callback", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, state } = z.object({ code: z.string(), state: z.string() }).parse(req.body ?? {});
    const payload = await consumeOAuthState(state);
    if (!payload) throw new BadRequestError("Invalid or expired OAuth state.");
    await exchangeCode(payload.userId, code);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Lightweight read endpoints (handy for the app + debugging).
router.get("/outlook/messages", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ messages: await listOutlookMessages((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

router.get("/outlook/events", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ events: await listOutlookEvents((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

router.get("/teams/chats", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ chats: await listTeamsChats((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

router.get("/onedrive/files", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query.q ? String(req.query.q) : undefined;
    res.json({ files: await listOneDriveFiles((req as AuthenticatedRequest).user.id, q) });
  } catch (err) {
    next(err);
  }
});

export default router;
