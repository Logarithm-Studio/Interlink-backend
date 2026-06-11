import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import {
  listGoogleCalendarEvents,
  listGmailMailboxMessages,
  getGmailMessageDetail,
  sendAutomatedGmailMessage,
} from "../services/googleApi.service";
import { ReauthRequiredError } from "../services/auth.service";
import { getDistanceFromOrigin } from "../services/googleMaps.service";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../utils/errors";
import { getEventById } from "../services/events.service";

const router = Router();

const CalendarQuerySchema = z.object({
  maxResults: z.coerce.number().int().min(1).max(50).optional(),
  calendarId: z.string().min(1).optional(),
  timeMin: z.string().datetime().optional(),
});

const GmailQuerySchema = z.object({
  mailbox: z.enum(["inbox", "sent", "all"]).optional(),
  maxResults: z.coerce.number().int().min(1).max(25).optional(),
  query: z.string().min(1).optional(),
});

const GmailDetailParamsSchema = z.object({
  messageId: z.string().min(1),
});

const SendAutomatedGmailResponseSchema = z.object({
  toEmail: z.string().email("Invalid recipient email"),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20_000),
  threadId: z.string().min(1).optional(),
  inReplyToMessageId: z.string().min(1).optional(),
});

const LatLngSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

const MapsDistanceSchema = z
  .object({
    origin: LatLngSchema,
    destination: z.object({
      eventId: z.string().uuid().optional(),
      address: z.string().trim().min(1).optional(),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
    }),
    mode: z.enum(["driving", "walking", "bicycling", "transit"]).optional(),
    units: z.enum(["metric", "imperial"]).optional(),
    departureTime: z.enum(["now"]).optional(),
  })
  .superRefine((value, ctx) => {
    const hasEventId = Boolean(value.destination.eventId);
    const hasAddress = Boolean(value.destination.address?.trim());
    const hasLat = value.destination.lat !== undefined;
    const hasLng = value.destination.lng !== undefined;
    const hasCoords = hasLat && hasLng;

    if (!hasEventId && !hasAddress && !hasCoords) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Destination must include one of: eventId, address, or lat/lng coordinates",
        path: ["destination"],
      });
    }

    if ((hasLat && !hasLng) || (!hasLat && hasLng)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Destination lat and lng must be provided together",
        path: ["destination"],
      });
    }
  });

router.use(authMiddleware as never);

function handleGoogleReauthError(err: unknown): UnauthorizedError | null {
  if (err instanceof ReauthRequiredError) {
    return new UnauthorizedError(
      "Google account needs reconnection before API calls can proceed",
    );
  }
  return null;
}

async function handleGmailMessages(
  req: Request,
  res: Response,
  next: NextFunction,
  mailboxOverride?: "inbox" | "sent" | "all",
): Promise<void> {
  try {
    const parsed = GmailQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues.map((issue) => issue.message).join(", "),
      );
    }

    const user = (req as AuthenticatedRequest).user;
    const mailbox = mailboxOverride ?? parsed.data.mailbox ?? "inbox";

    const messages = await listGmailMailboxMessages({
      userId: user.id,
      mailbox,
      maxResults: parsed.data.maxResults,
      query: parsed.data.query,
    });

    res.status(200).json({
      provider: "google",
      mailbox,
      count: messages.length,
      messages,
    });
  } catch (err) {
    const reauth = handleGoogleReauthError(err);
    if (reauth) {
      return next(reauth);
    }
    next(err);
  }
}

// Example: GET /api/v1/google/calendar/events?maxResults=10
router.get(
  "/calendar/events",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CalendarQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((issue) => issue.message).join(", "),
        );
      }

      const user = (req as AuthenticatedRequest).user;

      const events = await listGoogleCalendarEvents({
        userId: user.id,
        ...parsed.data,
      });

      res.status(200).json({
        provider: "google",
        events,
      });
    } catch (err) {
      const reauth = handleGoogleReauthError(err);
      if (reauth) {
        return next(reauth);
      }
      next(err);
    }
  },
);

// Example: GET /api/v1/google/gmail/messages?mailbox=inbox&maxResults=20
router.get(
  "/gmail/messages",
  async (req: Request, res: Response, next: NextFunction) => {
    await handleGmailMessages(req, res, next);
  },
);

// Example: GET /api/v1/google/gmail/messages/18f0f6f2...
router.get(
  "/gmail/messages/:messageId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = GmailDetailParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((issue) => issue.message).join(", "),
        );
      }

      const user = (req as AuthenticatedRequest).user;
      const message = await getGmailMessageDetail({
        userId: user.id,
        messageId: parsed.data.messageId,
      });

      res.status(200).json({
        provider: "google",
        message,
      });
    } catch (err) {
      const reauth = handleGoogleReauthError(err);
      if (reauth) {
        return next(reauth);
      }
      next(err);
    }
  },
);

// Convenience aliases used by the mobile app mail tabs.
router.get(
  "/gmail/inbox",
  async (req: Request, res: Response, next: NextFunction) => {
    await handleGmailMessages(req, res, next, "inbox");
  },
);

router.get(
  "/gmail/sent",
  async (req: Request, res: Response, next: NextFunction) => {
    await handleGmailMessages(req, res, next, "sent");
  },
);

// POST /api/v1/google/gmail/send-automated-response
router.post(
  "/gmail/send-automated-response",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SendAutomatedGmailResponseSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((issue) => issue.message).join(", "),
        );
      }

      const user = (req as AuthenticatedRequest).user;

      const sent = await sendAutomatedGmailMessage({
        userId: user.id,
        fromEmail: user.email,
        toEmail: parsed.data.toEmail,
        subject: parsed.data.subject,
        body: parsed.data.body,
        threadId: parsed.data.threadId,
        inReplyToMessageId: parsed.data.inReplyToMessageId,
      });

      res.status(201).json({
        provider: "google",
        message: "Automated Gmail response sent",
        sent,
      });
    } catch (err) {
      const reauth = handleGoogleReauthError(err);
      if (reauth) {
        return next(reauth);
      }
      next(err);
    }
  },
);

// POST /api/v1/google/maps/distance
router.post(
  "/maps/distance",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = MapsDistanceSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((issue) => issue.message).join(", "),
        );
      }

      const user = (req as AuthenticatedRequest).user;
      const destinationInput = parsed.data.destination;

      let destination:
        | { address: string }
        | { location: { lat: number; lng: number } };
      let sourceEventId: string | null = null;

      if (destinationInput.eventId) {
        const event = await getEventById(user.id, destinationInput.eventId);
        if (!event) {
          throw new NotFoundError("Event");
        }

        if (!event.location?.trim()) {
          throw new BadRequestError(
            "Selected event does not include a meeting location",
          );
        }

        sourceEventId = destinationInput.eventId;
        destination = { address: event.location.trim() };
      } else if (destinationInput.address?.trim()) {
        destination = { address: destinationInput.address.trim() };
      } else {
        destination = {
          location: {
            lat: destinationInput.lat!,
            lng: destinationInput.lng!,
          },
        };
      }

      const result = await getDistanceFromOrigin({
        origin: parsed.data.origin,
        destination,
        mode: parsed.data.mode,
        units: parsed.data.units,
        departureTime: parsed.data.departureTime,
      });

      res.status(200).json({
        provider: "google-maps",
        sourceEventId,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
