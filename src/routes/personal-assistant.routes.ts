/** /api/v1/personal-assistant — Personal Mode Gemini AI brain */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import {
  chat,
  command,
  executeAction,
  getChatHistory,
} from "../services/personal-assistant/personal-assistant.service";
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

// ─── Command (function-calling) ───────────────────────────────────────────────

const CommandBody = z.object({
  message: z.string().min(1).max(2000),
  // Optional attached image for multimodal reasoning (base64, no data: prefix).
  imageBase64: z.string().min(1).optional(),
  imageMimeType: z.string().optional(),
  // Optional caller coordinates for location-aware tools (weather).
  lat: z.number().optional(),
  lon: z.number().optional(),
});

router.post("/command", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CommandBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("message is required.");
    const { message, imageBase64, imageMimeType, lat, lon } = parsed.data;
    const image = imageBase64
      ? { data: imageBase64, mimeType: imageMimeType ?? "image/jpeg" }
      : undefined;
    res.json(await command(user.id, message, { image, lat, lon }));
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
});

router.post("/execute", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ExecuteBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("name is required.");

    const { name, args = {}, lat, lon } = parsed.data;
    const result = await executeAction(user.id, name, args, { lat, lon });

    // Record the outcome in the conversation so reopening the chat shows it.
    try {
      await query(
        `INSERT INTO personal_chat_messages (user_id, role, content) VALUES ($1, 'assistant', $2)`,
        [user.id, result.message],
      );
    } catch (err) {
      logger.warn("[personal-assistant] failed to persist execute result", { err: String(err) });
    }

    res.json(result);
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
