/** /api/v1/slack — Slack integration (OAuth v2 bot token) */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { oauthRateLimit } from "../middleware/rateLimit";
import { createOAuthState, consumeOAuthState } from "../services/oauth-state.service";
import {
  buildAuthUrl,
  exchangeCode,
  appRedirect,
  getChannels,
  postMessage,
  getUsers,
} from "../services/slack/slack.service";

const router = Router();

// ─── Public OAuth callback (NO authMiddleware) ─────────────────────────────────
// Slack redirects the browser here after consent — there is no JWT on this
// request, so the user is resolved from the single-use `state` token. Must be
// registered before router.use(authMiddleware) so it stays unauthenticated.
router.get("/callback", oauthRateLimit, async (req: Request, res: Response) => {
  try {
    const error = req.query.error ? String(req.query.error) : undefined;
    if (error) return res.redirect(302, appRedirect("error", error));

    const code = req.query.code ? String(req.query.code) : "";
    const state = req.query.state ? String(req.query.state) : "";
    if (!code || !state) return res.redirect(302, appRedirect("error", "missing_code_or_state"));

    const payload = await consumeOAuthState(state);
    if (!payload) return res.redirect(302, appRedirect("error", "invalid_state"));

    await exchangeCode(payload.userId, code);
    return res.redirect(302, appRedirect("success"));
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 80) : "exchange_failed";
    return res.redirect(302, appRedirect("error", detail));
  }
});

// ─── Everything below requires auth ────────────────────────────────────────────
router.use(authMiddleware as never);

router.get("/auth/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const state = await createOAuthState(user.id, "slack");
    res.json({ url: buildAuthUrl(state) });
  } catch (err) {
    next(err);
  }
});

router.get("/channels", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ channels: await getChannels((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

router.get("/users", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ users: await getUsers((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

const PostMessageBody = z.object({
  channel: z.string().min(1),
  text: z.string().min(1).max(4000),
});

router.post("/messages", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = PostMessageBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("channel and text are required.");
    res.status(201).json({ message: await postMessage(user.id, parsed.data.channel, parsed.data.text) });
  } catch (err) {
    next(err);
  }
});

export default router;
