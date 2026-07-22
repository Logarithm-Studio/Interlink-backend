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
import {
  EVENT_ALERT_TRIGGERS,
  enableEventAlerts,
  disableEventAlerts,
  listEnabledAlertToolkits,
  handleTriggerEvent,
  webhookSecret,
} from "../services/composio/composioTriggers.service";

const router = Router();

// ─── Public trigger webhook (NO authMiddleware) ───────────────────────────────
// Composio POSTs app events here (new Gmail message, Slack DM, deal moved, …). There's no
// JWT on this request, so it's guarded by a shared secret embedded in the URL we register
// with Composio — otherwise anyone who guessed the path could fabricate notifications.
// Always 200s: a non-2xx makes Composio retry the event forever.
router.post("/webhook", async (req: Request, res: Response) => {
  try {
    if (String(req.query.key ?? "") !== webhookSecret()) {
      return res.status(401).json({ ok: false });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const notified = await handleTriggerEvent(body);
    return res.json({ ok: true, notified });
  } catch {
    return res.json({ ok: true, notified: false });
  }
});

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

// ─── Per-app event alerts ─────────────────────────────────────────────────────
// Opt-in push notifications when something happens in a connected app. Only toolkits in
// EVENT_ALERT_TRIGGERS support this (a curated high-signal set, not a firehose).

/** Which toolkits support alerts, and which the user has switched on. */
router.get("/alerts", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json({
      supported: Object.keys(EVENT_ALERT_TRIGGERS),
      enabled: await listEnabledAlertToolkits(user.id),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/alerts/:toolkit", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const toolkit = String(req.params.toolkit).toLowerCase();
    if (!EVENT_ALERT_TRIGGERS[toolkit]) {
      throw new BadRequestError(`${toolkit} doesn't support event alerts yet.`);
    }
    const result = await enableEventAlerts(user.id, toolkit);
    if (result.enabled.length === 0) {
      throw new AppError(
        `Couldn't turn on ${toolkit} alerts. Make sure ${toolkit} is connected, then try again.`,
        422,
      );
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.delete("/alerts/:toolkit", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const toolkit = String(req.params.toolkit).toLowerCase();
    res.json({ ok: true, removed: await disableEventAlerts(user.id, toolkit) });
  } catch (err) {
    next(err);
  }
});

export default router;
