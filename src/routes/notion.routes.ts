/** /api/v1/notion — Notion API proxy */

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
  searchPages,
  createPage,
  getDatabases,
  queryDatabase,
} from "../services/notion/notion.service";

const router = Router();

// ─── Public Notion OAuth callback (NO authMiddleware) ──────────────────────────
// Notion requires an https redirect_uri and redirects the browser here (no JWT);
// the user is resolved from the single-use `state` token. Must be registered
// before router.use(authMiddleware) so it stays unauthenticated.
router.get("/callback", oauthRateLimit, async (req: Request, res: Response) => {
  try {
    const error = req.query.error ? String(req.query.error) : undefined;
    if (error) return res.redirect(302, appRedirect("notion", "error", error));

    const code = req.query.code ? String(req.query.code) : "";
    const state = req.query.state ? String(req.query.state) : "";
    if (!code || !state) return res.redirect(302, appRedirect("notion", "error", "missing_code_or_state"));

    const payload = await consumeOAuthState(state);
    if (!payload) return res.redirect(302, appRedirect("notion", "error", "invalid_state"));

    await exchangeCode(payload.userId, code);
    return res.redirect(302, appRedirect("notion", "success"));
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 80) : "exchange_failed";
    return res.redirect(302, appRedirect("notion", "error", detail));
  }
});

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
