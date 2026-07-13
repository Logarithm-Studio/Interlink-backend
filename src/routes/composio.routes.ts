/**
 * /api/v1/composio — connect the long tail of third-party apps via Composio.
 *
 * Unlike the native OAuth routers (todoist/slack/notion/…), there is no code-exchange
 * callback to implement here: Composio owns the OAuth app and completes the exchange on
 * its side. The app opens the consent URL, then polls GET /connections, which reconciles
 * against Composio and flips the row to `active`.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { AppError, BadRequestError } from "../utils/errors";
import { oauthRateLimit } from "../middleware/rateLimit";
import { appRedirect } from "../services/integrations/oauthAppRedirect";
import {
  isComposioLive,
  getCatalog,
  isKnownToolkit,
  connectToolkit,
  syncConnections,
  listConnections,
  disconnectToolkit,
} from "../services/composio/composio.service";

const router = Router();

// ─── Public return landing (NO authMiddleware) ────────────────────────────────
// Composio can be configured to send the browser here after consent. There is no JWT on
// this request and nothing to exchange — we just bounce back into the app, which then
// polls /connections. Registered before authMiddleware so it stays unauthenticated.
router.get("/callback", oauthRateLimit, (req: Request, res: Response) => {
  const status = req.query.status === "error" ? "error" : "success";
  const detail = req.query.error ? String(req.query.error).slice(0, 80) : undefined;
  return res.redirect(302, appRedirect("composio", status, detail));
});

router.use(authMiddleware as never);

/** The curated toolkit catalog, annotated with this user's connection status. */
router.get("/toolkits", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const connections = await listConnections(user.id);
    const bySlug = new Map(connections.map((c) => [c.toolkitSlug, c]));

    res.json({
      available: isComposioLive(),
      toolkits: getCatalog().map((t) => ({
        ...t,
        status: bySlug.get(t.slug)?.status ?? "disconnected",
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Live connection state. The app polls this after the browser consent step. */
router.get("/connections", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json({ connections: await syncConnections(user.id) });
  } catch (err) {
    next(err);
  }
});

const ConnectBody = z.object({ toolkit: z.string().min(1).max(64) });

/** Start an OAuth connect → returns the Composio-hosted consent URL for the app to open. */
router.post("/connect", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    if (!isComposioLive()) {
      throw new AppError("Composio is not configured on the server.", 503);
    }

    const parsed = ConnectBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("A toolkit slug is required.");

    const toolkit = parsed.data.toolkit.toLowerCase();
    if (!isKnownToolkit(toolkit)) throw new BadRequestError(`Unknown toolkit "${toolkit}".`);

    res.json(await connectToolkit(user.id, toolkit));
  } catch (err) {
    next(err);
  }
});

router.delete("/connections/:toolkit", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const toolkit = String(req.params.toolkit).toLowerCase();
    if (!isKnownToolkit(toolkit)) throw new BadRequestError(`Unknown toolkit "${toolkit}".`);

    await disconnectToolkit(user.id, toolkit);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
