/**
 * Notification Hub routes — the cross-app queue of things waiting on the user.
 *
 * Routes:
 *   GET  /api/v1/notifications                  — feed for the active mode
 *   GET  /api/v1/notifications/unread-count     — counts for BOTH modes (bell + mode toggle)
 *   GET  /api/v1/notifications/health           — per-source status for the widget health line
 *   POST /api/v1/notifications/:id/resolve      — user handled it here
 *   POST /api/v1/notifications/:id/dismiss      — user does not want it
 *   POST /api/v1/notifications/:id/opened-external — user tapped through to the source app
 *   POST /api/v1/notifications/:id/draft-reply     — propose an AI reply (sends nothing)
 *   POST /api/v1/notifications/:id/send-reply      — send the reply the user approved
 *
 * The active mode comes from the `X-Interlink-Mode` header, the same one the app already sends
 * on every request and namespaces its response cache by.
 *
 * `opened-external` looks like telemetry but is load-bearing: the success metric for this whole
 * feature is the ratio of inline actions to deep-links out. Recording only the actions would
 * make the hub look successful no matter what people actually did.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { parseAppMode } from "../middleware/googleAccount";
import { AuthenticatedRequest } from "../types";
import { BadRequestError, NotFoundError } from "../utils/errors";
import {
  getFeed,
  getUnreadCounts,
  getSourceHealth,
  recordAction,
  type HubMode,
} from "../services/notifications/hub.service";
import { getDailySummary } from "../services/notifications/hubSummary.service";
import { draftReply, sendReply } from "../services/notifications/hubReply.service";
import { triggerUserHubRefresh } from "../services/notifications/hubScheduler.service";

const router = Router();

router.use(authMiddleware as never);

const IdSchema = z.string().uuid("id must be a uuid");

/** Default to personal when the header is absent — matches how the app behaves on first launch. */
function activeMode(req: Request): HubMode {
  return parseAppMode(req.headers["x-interlink-mode"]) ?? "personal";
}

// ─── GET /api/v1/notifications ───────────────────────────────────────
// `includeCalendar=false` (the default) is what the Events widget asks for: the event list sits
// directly beneath it, and calendar items would render twice on one screen. The full
// notification screen passes `includeCalendar=true`.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const includeCalendar = req.query.includeCalendar === "true";
    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
        ? Math.min(parseInt(limitRaw, 10), 100)
        : 50;

    const mode = activeMode(req);

    const items = await getFeed({ userId: user.id, mode, includeCalendar, limit });

    // The narration is cached once per user per day and shared with the daily digest, so this
    // is a cheap read on all but the first call. It must never block the list: on any failure
    // `getDailySummary` returns the deterministic sentence instead of throwing.
    const summary = await getDailySummary(user.id, mode).catch(() => null);

    res.json({
      success: true,
      data: {
        items,
        mode,
        summary: summary?.summary ?? null,
        summaryIsFallback: summary?.isFallback ?? true,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/notifications/unread-count ──────────────────────────
// Returns both modes. The bell shows a dot for the current mode; the mode toggle shows that
// something is waiting on the other side — the count crosses the boundary even though items
// never do.
router.get(
  "/unread-count",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const counts = await getUnreadCounts(user.id);
      res.json({ success: true, data: counts });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/notifications/health ────────────────────────────────
// Surfaced IN the widget, not buried in settings: a hub that has silently stopped ingesting is
// worse than no hub, because the user has stopped checking the real apps.
router.get("/health", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const sources = await getSourceHealth(user.id);
    res.json({ success: true, data: { sources } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/notifications/refresh ──────────────────────────────
// Actually go and LOOK. Every other endpoint here only reads rows the hourly tick already wrote,
// so before this existed nothing the user could do would make the hub check their accounts: a
// freshly connected source showed an empty feed for up to an hour and pull-to-refresh just
// redisplayed the same stale list. External sources are enqueued (they are slow, rate-limited
// API calls); local SQL adapters run inline, so the response already reflects them.
router.post("/refresh", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const triggered = await triggerUserHubRefresh(user.id);
    res.json({ success: true, data: { triggered } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/notifications/:id/(resolve|dismiss|opened-external) ─

async function handleAction(
  req: Request,
  res: Response,
  next: NextFunction,
  action: "resolve" | "dismiss" | "opened_external",
): Promise<void> {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = IdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues.map((i) => i.message).join(", "));
    }

    const ok = await recordAction(
      user.id,
      parsed.data,
      action,
      (req as AuthenticatedRequest & { requestId?: string }).requestId,
    );
    if (!ok) throw new NotFoundError("Notification not found.");

    res.json({ success: true, data: { id: parsed.data, action } });
  } catch (err) {
    next(err);
  }
}

// ─── Inline reply (Gmail items) ──────────────────────────────────────
// Two steps on purpose. `draft-reply` proposes and mutates nothing; `send-reply` sends the text
// the user actually approved. One-tap send of model-written text to a real colleague is the
// failure mode that gets a feature switched off after a single bad send.

router.post("/:id/draft-reply", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = IdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues.map((i) => i.message).join(", "));
    }
    const draft = await draftReply(user.id, parsed.data);
    res.json({ success: true, data: draft });
  } catch (err) {
    next(err);
  }
});

const SendReplySchema = z.object({
  // The exact text the user saw and edited. The server never regenerates it.
  body: z.string().min(1, "body is required").max(10_000),
});

router.post("/:id/send-reply", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const id = IdSchema.safeParse(req.params.id);
    if (!id.success) {
      throw new BadRequestError(id.error.issues.map((i) => i.message).join(", "));
    }
    const parsed = SendReplySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues.map((i) => i.message).join(", "));
    }

    const result = await sendReply(
      user.id,
      id.data,
      parsed.data.body,
      (req as AuthenticatedRequest & { requestId?: string }).requestId,
    );
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/resolve", (req, res, next) =>
  handleAction(req, res, next, "resolve"),
);

router.post("/:id/dismiss", (req, res, next) =>
  handleAction(req, res, next, "dismiss"),
);

router.post("/:id/opened-external", (req, res, next) =>
  handleAction(req, res, next, "opened_external"),
);

export default router;
