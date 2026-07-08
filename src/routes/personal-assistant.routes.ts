/** /api/v1/personal-assistant — Personal Mode Gemini AI brain */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import {
  chat,
  clearChatHistory,
  command,
  deriveOpenLinks,
  executeAction,
  getChatHistory,
  getConversationMessages,
  getLifeSummary,
  listConversations,
} from "../services/personal-assistant/personal-assistant.service";
import { resolveGoogleAccountForRequest } from "../middleware/googleAccount";
import { transcribeAudio } from "../services/ai/multimodal.service";
import { query } from "../config/db";
import { logger } from "../observability/logger";

const router = Router();
router.use(authMiddleware as never);

// ─── Chat ─────────────────────────────────────────────────────────────────────

const ChatBody = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).optional(),
});

router.post("/chat", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ChatBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("message is required.");
    res.json(await chat(user.id, parsed.data.message, parsed.data.history));
  } catch (err) {
    next(err);
  }
});

router.get("/history", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ messages: await getChatHistory((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

router.delete("/history", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await clearChatHistory((req as AuthenticatedRequest).user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Conversations (chat-history sessions) ─────────────────────────────────────

router.get("/conversations", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ conversations: await listConversations((req as AuthenticatedRequest).user.id) });
  } catch (err) {
    next(err);
  }
});

router.get("/conversations/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const messages = await getConversationMessages((req as AuthenticatedRequest).user.id, req.params.id);
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

// ─── Life hub summary ──────────────────────────────────────────────────────────
// Mode-scoped (Personal vs Work) via the Google-account resolver, so the hub reflects
// the calendar that matches the active mode.

router.get(
  "/summary",
  resolveGoogleAccountForRequest as never,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authed = req as AuthenticatedRequest;
      const now = typeof req.query.now === "string" ? req.query.now : undefined;
      const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
      res.json(
        await getLifeSummary(authed.user.id, { now, tz, googleAccountId: authed.googleAccountId }),
      );
    } catch (err) {
      next(err);
    }
  },
);

// ─── Command (function-calling) ───────────────────────────────────────────────

const CommandBody = z.object({
  message: z.string().min(1).max(2000),
  // Optional attached image for multimodal reasoning (base64, no data: prefix).
  imageBase64: z.string().min(1).optional(),
  imageMimeType: z.string().optional(),
  // Optional non-image file attachment (base64) — held for upload_to_drive.
  fileBase64: z.string().min(1).optional(),
  fileMimeType: z.string().optional(),
  fileName: z.string().optional(),
  // Optional caller coordinates for location-aware tools (weather).
  lat: z.number().optional(),
  lon: z.number().optional(),
  // Client clock + timezone so relative dates ("today", "tomorrow") resolve correctly.
  clientNow: z.string().optional(),
  tz: z.string().optional(),
  // Conversation thread to append to (omit to start a new one).
  conversationId: z.string().optional(),
});

router.post("/command", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CommandBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("message is required.");
    const { message, imageBase64, imageMimeType, fileBase64, fileMimeType, fileName, lat, lon, clientNow, tz, conversationId } =
      parsed.data;
    const image = imageBase64
      ? { data: imageBase64, mimeType: imageMimeType ?? "image/jpeg" }
      : undefined;
    const attachment = fileBase64
      ? { base64: fileBase64, mimeType: fileMimeType ?? "application/octet-stream", name: fileName ?? "Upload" }
      : undefined;
    res.json(await command(user.id, message, { image, attachment, lat, lon, clientNow, tz, conversationId }));
  } catch (err) {
    next(err);
  }
});

// ─── Execute confirmed action ────────────────────────────────────────────────

const ExecuteBody = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  conversationId: z.string().optional(),
  // File bytes for upload_to_drive (the attachment the command was about).
  fileBase64: z.string().min(1).optional(),
  fileMimeType: z.string().optional(),
  fileName: z.string().optional(),
});

router.post("/execute", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ExecuteBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("name is required.");

    const { name, args = {}, lat, lon, conversationId, fileBase64, fileMimeType, fileName } = parsed.data;
    const attachment = fileBase64
      ? { base64: fileBase64, mimeType: fileMimeType ?? "application/octet-stream", name: fileName ?? "Upload" }
      : undefined;
    const result = await executeAction(user.id, name, args, { lat, lon, attachment });
    const links = deriveOpenLinks(name, args, result.data);

    // Record the outcome in the conversation so reopening the chat shows it.
    try {
      await query(
        `INSERT INTO personal_chat_messages (user_id, role, content, conversation_id) VALUES ($1, 'assistant', $2, $3)`,
        [user.id, result.message, conversationId ?? null],
      );
      if (conversationId) {
        await query(`UPDATE personal_conversations SET updated_at = now() WHERE id = $1`, [conversationId]).catch(
          () => {},
        );
      }
    } catch (err) {
      logger.warn("[personal-assistant] failed to persist execute result", { err: String(err) });
    }

    res.json({ ...result, links: links.length ? links : undefined });
  } catch (err) {
    next(err);
  }
});

// ─── Voice transcription ──────────────────────────────────────────────────────

const TranscribeBody = z.object({ audioBase64: z.string().min(1), mimeType: z.string().optional() });

router.post("/transcribe", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = TranscribeBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("audioBase64 is required.");
    res.json(await transcribeAudio(parsed.data.audioBase64, parsed.data.mimeType));
  } catch (err) {
    next(err);
  }
});

export default router;
