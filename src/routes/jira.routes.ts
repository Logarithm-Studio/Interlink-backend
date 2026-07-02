/** /api/v1/jira — Jira Cloud (Atlassian) API proxy */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { oauthRateLimit } from "../middleware/rateLimit";
import { createOAuthState, consumeOAuthState } from "../services/oauth-state.service";
import { appRedirect } from "../services/integrations/oauthAppRedirect";
import {
  buildAuthUrl,
  exchangeCode,
  getProjects,
  searchIssues,
  createIssue,
  getMyself,
} from "../services/jira/jira.service";

const router = Router();

// ─── Public Jira OAuth callback (NO authMiddleware) ────────────────────────────
// Atlassian requires an https redirect_uri and redirects the browser here (no
// JWT); the user is resolved from the single-use `state` token. Must be
// registered before router.use(authMiddleware) so it stays unauthenticated.
router.get("/callback", oauthRateLimit, async (req: Request, res: Response) => {
  try {
    const error = req.query.error ? String(req.query.error) : undefined;
    if (error) return res.redirect(302, appRedirect("jira", "error", error));

    const code = req.query.code ? String(req.query.code) : "";
    const state = req.query.state ? String(req.query.state) : "";
    if (!code || !state) return res.redirect(302, appRedirect("jira", "error", "missing_code_or_state"));

    const payload = await consumeOAuthState(state);
    if (!payload) return res.redirect(302, appRedirect("jira", "error", "invalid_state"));

    await exchangeCode(payload.userId, code);
    return res.redirect(302, appRedirect("jira", "success"));
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 80) : "exchange_failed";
    return res.redirect(302, appRedirect("jira", "error", detail));
  }
});

router.use(authMiddleware as never);

// ─── OAuth ──────────────────────────────────────────────────────────────────

router.get("/auth/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const state = await createOAuthState(user.id, "jira");
    res.json({ url: buildAuthUrl(state) });
  } catch (err) {
    next(err);
  }
});

// Mobile custom-scheme flow: the app receives the code and POSTs it here.
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

// ─── Projects ─────────────────────────────────────────────────────────────────

router.get("/projects", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ projects: await getProjects((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

// ─── Issues ─────────────────────────────────────────────────────────────────

router.get("/issues", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const jql = req.query.jql ? String(req.query.jql) : undefined;
    res.json({ issues: await searchIssues(user.id, jql) });
  } catch (err) {
    next(err);
  }
});

const CreateIssueBody = z.object({
  projectKey: z.string().min(1),
  summary: z.string().min(1).max(255),
  description: z.string().max(10000).optional(),
  issueType: z.string().max(50).optional(),
});

router.post("/issues", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CreateIssueBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("projectKey and summary are required.");
    res.status(201).json({ issue: await createIssue(user.id, parsed.data) });
  } catch (err) {
    next(err);
  }
});

// ─── Connection check ─────────────────────────────────────────────────────────

router.get("/me", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ user: await getMyself((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

export default router;
