/** /api/v1/todoist — Todoist REST API v2 proxy */

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
  getTasks,
  createTask,
  closeTask,
} from "../services/todoist/todoist.service";
import { oauthRateLimit } from "../middleware/rateLimit";
import { appRedirect } from "../services/integrations/oauthAppRedirect";

const router = Router();

// ─── Public Todoist OAuth callback (NO authMiddleware) ─────────────────────────
// Todoist redirects the browser here after consent — there is no JWT on this
// request, so the user is resolved from the single-use `state` token. Must be
// registered before router.use(authMiddleware) so it stays unauthenticated.
router.get("/callback", oauthRateLimit, async (req: Request, res: Response) => {
  try {
    const error = req.query.error ? String(req.query.error) : undefined;
    if (error) return res.redirect(302, appRedirect("todoist", "error", error));

    const code = req.query.code ? String(req.query.code) : "";
    const state = req.query.state ? String(req.query.state) : "";
    if (!code || !state) return res.redirect(302, appRedirect("todoist", "error", "missing_code_or_state"));

    const payload = await consumeOAuthState(state);
    if (!payload) return res.redirect(302, appRedirect("todoist", "error", "invalid_state"));

    await exchangeCode(payload.userId, code);
    return res.redirect(302, appRedirect("todoist", "success"));
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 80) : "exchange_failed";
    return res.redirect(302, appRedirect("todoist", "error", detail));
  }
});

router.use(authMiddleware as never);

router.get("/auth/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const state = await createOAuthState(user.id, "todoist");
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

router.get("/projects", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ projects: await getProjects((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

router.get("/tasks", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const projectId = req.query.project_id ? String(req.query.project_id) : undefined;
    res.json({ tasks: await getTasks(user.id, projectId) });
  } catch (err) {
    next(err);
  }
});

const CreateBody = z.object({
  content: z.string().min(1).max(500),
  dueString: z.string().optional(),
  priority: z.number().int().min(1).max(4).optional(),
  projectId: z.string().optional(),
});

router.post("/tasks", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("content is required.");
    res.status(201).json({ task: await createTask(user.id, parsed.data) });
  } catch (err) {
    next(err);
  }
});

router.post("/tasks/:id/close", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await closeTask((req as AuthenticatedRequest).user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
