/** /api/v1/notion — Notion API proxy */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { createOAuthState, consumeOAuthState } from "../services/oauth-state.service";
import {
  buildAuthUrl,
  exchangeCode,
  searchPages,
  createPage,
  getDatabases,
  queryDatabase,
} from "../services/notion/notion.service";

const router = Router();
router.use(authMiddleware as never);

router.get("/auth/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const state = await createOAuthState(user.id, "notion");
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

router.get("/pages", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const q = String(req.query.q ?? "");
    res.json({ pages: await searchPages(user.id, q) });
  } catch (err) {
    next(err);
  }
});

const CreatePageBody = z.object({
  parentId: z.string().min(1),
  title: z.string().min(1).max(255),
  content: z.string().max(10000).optional(),
});

router.post("/pages", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CreatePageBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("parentId and title are required.");
    res.status(201).json({ page: await createPage(user.id, parsed.data) });
  } catch (err) {
    next(err);
  }
});

router.get("/databases", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ databases: await getDatabases((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

const QueryBody = z.object({ filter: z.record(z.unknown()).optional() });

router.post("/databases/:id/query", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = QueryBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid query body.");
    res.json({ results: await queryDatabase(user.id, req.params.id, parsed.data.filter) });
  } catch (err) {
    next(err);
  }
});

export default router;
