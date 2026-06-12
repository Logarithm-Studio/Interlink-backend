import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import {
  getUserEvents,
  getEventById,
  toFlutterEventListItem,
  toFlutterEventDetail,
} from "../services/events.service";
import {
  AuthError,
  sendDeclineEmailForEvent,
} from "../services/email/declineEmail.service";
import {
  getAttendanceResponseForEvent,
  listAttendanceResponsesForEvents,
  upsertAttendanceResponse,
  type AttendanceResponseValue,
} from "../services/attendanceResponses.service";
import { listEmailSendLogsForEvent } from "../services/email/sendLogs.service";
import { acceptGoogleEvent, declineGoogleEvent } from "../services/calendar/google";
import { AuthenticatedRequest } from "../types";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../utils/errors";
import { ReauthRequiredError } from "../services/auth.service";

const router = Router();

const SendDeclineEmailSchema = z.object({
  templateId: z.string().uuid().or(z.literal("system-default")).optional(),
  customSubject: z.string().min(1).max(500).optional(),
  customBody: z.string().min(1).max(10_000).optional(),
  sendToOrganizer: z.boolean().optional(),
  sendToAttendees: z.boolean().optional(),
});

const AttendanceResponseSchema = z.object({
  response: z.enum(["yes", "no"]),
});

function buildEventStateFlags(
  endTime: Date,
  attendanceResponse: AttendanceResponseValue | null,
): {
  isPast: boolean;
  isHandled: boolean;
  isMissed: boolean;
} {
  const endMs = endTime.getTime();
  const isPast = Number.isFinite(endMs) && endMs <= Date.now();
  const isHandled = attendanceResponse !== null;
  const isMissed = isPast && !isHandled;

  return { isPast, isHandled, isMissed };
}

// All event routes require authentication
router.use(authMiddleware as never);

// ─── GET /api/v1/events ─────────────────────────────────────────────
// List upcoming events for the authenticated user.
// Defaults to events ending after now, sorted chronologically.
// Optional ?from= and ?to= ISO date query params may narrow the range.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    const events = await getUserEvents(user.id, from, to);
    const attendanceResponses = await listAttendanceResponsesForEvents(
      user.id,
      events.map((event) => event.id).filter(Boolean) as string[],
    );

    res.json({
      events: events.map((event) => {
        const attendanceResponse = attendanceResponses[event.id ?? ""] ?? null;
        return {
          ...buildEventStateFlags(event.endTime, attendanceResponse),
          ...toFlutterEventListItem(event),
          attendanceResponse,
        };
      }),
      count: events.length,
      filters: {
        from: from ?? new Date().toISOString(),
        to: to ?? null,
        upcomingOnly: true,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/events/:id ─────────────────────────────────────────
// Get full detail for a single event by ID.
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const event = await getEventById(user.id, req.params.id);

    if (!event) {
      throw new NotFoundError("Event");
    }

    const attendanceResponse = await getAttendanceResponseForEvent(
      user.id,
      req.params.id,
    );

    res.json({
      event: {
        ...buildEventStateFlags(
          event.endTime,
          attendanceResponse?.response ?? null,
        ),
        ...toFlutterEventDetail(event),
        attendanceResponse: attendanceResponse?.response ?? null,
        attendanceHandledAt: attendanceResponse?.handledAt ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/v1/events/:id/attendance-response ─────────────────
// Records a user's Yes/No attendance decision so repeated prompts can be suppressed.
router.post(
  "/:id/attendance-response",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = AttendanceResponseSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((issue) => issue.message).join(", "),
        );
      }

      const event = await getEventById(user.id, req.params.id);
      if (!event) {
        throw new NotFoundError("Event");
      }

      // Persist to Google first so local attendance state always reflects what
      // actually exists in the user's Google Calendar account.
      const externalId = event.externalEventId;
      if (externalId) {
        const metadata =
          event.metadata && typeof event.metadata === "object"
            ? (event.metadata as Record<string, unknown>)
            : {};
        const sourceCalendarId =
          typeof metadata.calendarId === "string" && metadata.calendarId.trim()
            ? metadata.calendarId.trim()
            : "primary";

        try {
          if (parsed.data.response === "yes") {
            await acceptGoogleEvent(
              user.id,
              user.email,
              externalId,
              sourceCalendarId,
            );
          } else {
            await declineGoogleEvent(
              user.id,
              user.email,
              externalId,
              sourceCalendarId,
            );
          }
        } catch (calErr) {
          // Best-effort: Google Calendar sync failure does not block recording attendance.
          console.warn(
            `[attendance-response] Google Calendar update skipped for event=${req.params.id}: ${calErr instanceof Error ? calErr.message : String(calErr)}`,
          );
        }
      }

      const attendanceResponse = await upsertAttendanceResponse({
        userId: user.id,
        eventId: req.params.id,
        response: parsed.data.response,
      });

      res.status(200).json({
        message: "Attendance response recorded",
        eventId: req.params.id,
        response: attendanceResponse.response,
        handledAt: attendanceResponse.handledAt,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/events/:id/decline-email-logs ───────────────────
// Lists explicit decline email send history for this event/user.
router.get(
  "/:id/decline-email-logs",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      const logs = await listEmailSendLogsForEvent(user.id, req.params.id);
      res.json({ logs, count: logs.length });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/events/:id/send-decline-email ───────────────────
// Sends decline email in one call for Flutter "No" action.
router.post(
  "/:id/send-decline-email",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = SendDeclineEmailSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((issue) => issue.message).join(", "),
        );
      }

      const result = await sendDeclineEmailForEvent({
        user,
        eventId: req.params.id,
        templateId: parsed.data.templateId,
        customSubject: parsed.data.customSubject,
        customBody: parsed.data.customBody,
        sendToOrganizer: parsed.data.sendToOrganizer,
        sendToAttendees: parsed.data.sendToAttendees,
      });

      res.status(200).json({
        message: "Decline email processed",
        ...result,
      });
    } catch (err) {
      if (err instanceof AuthError || err instanceof ReauthRequiredError) {
        next(
          new UnauthorizedError(
            "Google authorization failed. Please reconnect your Google account.",
          ),
        );
        return;
      }
      next(err);
    }
  },
);

export default router;
