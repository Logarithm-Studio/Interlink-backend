/** /api/v1/jira — Jira Cloud (Atlassian) API proxy */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { createOAuthState, consumeOAuthState } from "../services/oauth-state.service";
import {
  buildAuthUrl,
  exchangeCode,
  getProjects,
  searchIssues,
  createIssue,
  getMyself,
} from "../services/jira/jira.service";

const router = Router();
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
