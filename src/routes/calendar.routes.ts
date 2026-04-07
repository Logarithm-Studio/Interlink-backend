import { randomUUID } from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../middleware/auth";
import { syncUserCalendar } from "../services/calendar/sync";
import {
  createWatchChannel,
  getChannelByChannelId,
} from "../services/calendar/googleWatch.service";
import { ReauthRequiredError } from "../services/auth.service";
import { getCalendarSyncQueue } from "../queues/queues";
import { JobType } from "../jobs/schemas/envelope";
import { AuthenticatedRequest } from "../types";
import { BadRequestError, UnauthorizedError } from "../utils/errors";
import { isDuplicate, buildWebhookDedupeKey } from "../security/idempotency";
import { webhookRateLimit } from "../middleware/rateLimit";

const router = Router();

// ─── POST /api/v1/calendar/sync ─────────────────────────────────────
// Manually trigger a full calendar sync for the authenticated user.
router.post(
  "/sync",
  authMiddleware as never,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const provider = (req.query.provider as string) || "google";

      if (provider !== "google") {
        throw new BadRequestError(
          "Only Google Calendar sync is supported in Phase 1",
        );
      }

      const result = await syncUserCalendar(
        user.id,
        provider as "google",
        req.query.since as string | undefined,
      );

      res.json({
        message: `Calendar sync complete for ${provider}`,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/calendar/watch/google ─────────────────────────────
// Authenticated: registers a Google Calendar push-notification channel
// for the current user. Requires GOOGLE_WEBHOOK_URL to be set.
router.post(
  "/watch/google",
  authMiddleware as never,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const calendarId = (req.body?.calendarId as string) || "primary";

      const channel = await createWatchChannel(user.id, calendarId);

      res.status(201).json({
        message: "Watch channel created",
        channelId: channel.channelId,
        calendarId: channel.calendarId,
        expiration: channel.expiration,
      });
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        return next(
          new UnauthorizedError(
            "Google account requires re-authentication. Reconnect and try again.",
          ),
        );
      }
      if (
        err instanceof Error &&
        err.message === "No Google account connected"
      ) {
        return next(
          new BadRequestError(
            "Google account is not connected. Connect Google first.",
          ),
        );
      }
      next(err);
    }
  },
);

// ─── POST /api/v1/calendar/webhook/google ───────────────────────────
// Public endpoint — Google pushes notifications here (no auth header).
//
// Flow:
//   1. Respond 200 immediately (Google requires a reply within 10 s).
//   2. Ignore the initial 'sync' handshake notification.
//   3. Look up the channel, verify token + resourceId to prevent spoofing.
//   4. Enqueue a calendar.google.sync job with a deterministic jobId so
//      burst notifications coalesce into a single sync run.
router.post(
  "/webhook/google",
  webhookRateLimit,
  async (req: Request, res: Response) => {
    // Acknowledge first — Google will retry if we don't respond promptly.
    res.status(200).send();

    const channelId = req.headers["x-goog-channel-id"] as string | undefined;
    const resourceId = req.headers["x-goog-resource-id"] as string | undefined;
    const resourceState = req.headers["x-goog-resource-state"] as
      | string
      | undefined;
    const messageNumber = req.headers["x-goog-message-number"] as
      | string
      | undefined;
    const channelToken = req.headers["x-goog-channel-token"] as
      | string
      | undefined;

    // 'sync' is Google's initial handshake — no calendar data to sync yet.
    if (!channelId || resourceState === "sync") {
      console.log(
        `[webhook/google] sync handshake received — no action needed`,
      );
      return;
    }

    // ── Short-window replay protection ────────────────────────────────
    // Google guarantees at-least-once delivery; retries carry identical headers.
    // Dedupe on (channelId + resourceId + messageNumber) with a 48 h TTL, which
    // safely exceeds Google's maximum webhook retry window (~24 h).
    if (channelId && resourceId && messageNumber) {
      const dedupeKey = buildWebhookDedupeKey(
        channelId,
        resourceId,
        messageNumber,
      );
      const duplicate = await isDuplicate(dedupeKey, 172_800); // 48 h
      if (duplicate) {
        console.log(
          `[webhook/google] Duplicate notification suppressed | channel=${channelId} msg=${messageNumber}`,
        );
        return;
      }
    }

    try {
      const channel = await getChannelByChannelId(channelId);
      if (!channel) {
        // Stale or unknown channel — ignore silently (the channel will expire).
        console.warn(
          `[webhook/google] Unknown channel ${channelId} — ignoring`,
        );
        return;
      }

      // Verify the opaque token we set at channel creation to detect spoofed POSTs.
      if (channelToken && channelToken !== channel.channelToken) {
        console.warn(
          `[webhook/google] Token mismatch for channel ${channelId} — ignoring`,
        );
        return;
      }

      if (resourceId && resourceId !== channel.resourceId) {
        console.warn(
          `[webhook/google] resourceId mismatch for channel ${channelId} — ignoring`,
        );
        return;
      }

      // Deterministic jobId: burst notifications for the same channel collapse
      // into a single BullMQ job (the second add with the same jobId is a no-op).
      const jobId = `google-sync|${channelId}|${messageNumber ?? randomUUID()}`;

      await getCalendarSyncQueue().add(
        JobType.GOOGLE_SYNC,
        {
          jobType: JobType.GOOGLE_SYNC,
          requestId: randomUUID(),
          idempotencyKey: jobId,
          userId: channel.userId,
          payload: { channelId, calendarId: channel.calendarId },
        },
        {
          jobId,
          // calendar.*.sync policy: 8 attempts, exponential 30s base, 30m cap.
          attempts: 8,
          backoff: { type: "calendar_exp" as "exponential", delay: 30_000 },
        },
      );

      console.log(
        `[webhook/google] Enqueued sync job ${jobId} for user ${channel.userId}`,
      );
    } catch (err) {
      console.error("[webhook/google] Error processing notification:", err);
    }
  },
);

export default router;
