/** /api/v1/tasks — Google Tasks API proxy */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import {
  getTaskLists,
  getTasksInList,
  createTask,
  updateTask,
  deleteTask,
  completeTask,
} from "../services/tasks/tasks.service";

const router = Router();
router.use(authMiddleware as never);

router.get("/lists", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ lists: await getTaskLists((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

router.get("/:listId/tasks", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const showCompleted = req.query.completed === "true";
    res.json({ tasks: await getTasksInList(user.id, req.params.listId, { showCompleted }) });
  } catch (err) {
    next(err);
  }
});

const CreateBody = z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(8000).optional(),
  due: z.string().optional(),
});

router.post("/:listId/tasks", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("title is required.");
    res.status(201).json({ task: await createTask(user.id, req.params.listId, parsed.data) });
  } catch (err) {
    next(err);
  }
});

const PatchBody = z.object({
  title: z.string().min(1).max(500).optional(),
  notes: z.string().max(8000).optional(),
  due: z.string().optional(),
  status: z.enum(["needsAction", "completed"]).optional(),
});

router.patch("/:listId/tasks/:taskId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = PatchBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid patch body.");
    res.json({ task: await updateTask(user.id, req.params.listId, req.params.taskId, parsed.data) });
  } catch (err) {
    next(err);
  }
});

router.post("/:listId/tasks/:taskId/complete", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json({ task: await completeTask(user.id, req.params.listId, req.params.taskId) });
  } catch (err) {
    next(err);
  }
});

router.delete("/:listId/tasks/:taskId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteTask((req as AuthenticatedRequest).user.id, req.params.listId, req.params.taskId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
