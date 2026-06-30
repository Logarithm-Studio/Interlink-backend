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

const router = Router();
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
