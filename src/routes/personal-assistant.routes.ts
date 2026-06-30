/** /api/v1/personal-assistant — Personal Mode Gemini AI brain */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { chat, command, getChatHistory } from "../services/personal-assistant/personal-assistant.service";
import { transcribeAudio } from "../services/ai/multimodal.service";

// Personal assistant actions executor
import { getNowPlaying, resumePlayback, pausePlayback, skipToNext, search, playContext, playTrack } from "../services/spotify/spotify.service";
import { getCurrentWeather } from "../services/weather/weather.service";
import { getDailySummary } from "../services/fitness/fitness.service";
import { getTaskLists, getTasksInList, createTask as createGoogleTask } from "../services/tasks/tasks.service";
import { createTask as createTodoistTask } from "../services/todoist/todoist.service";
import { getUserEvents } from "../services/events.service";

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
});

router.post("/command", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CommandBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("message is required.");
    const { message, imageBase64, imageMimeType } = parsed.data;
    const image = imageBase64
      ? { data: imageBase64, mimeType: imageMimeType ?? "image/jpeg" }
      : undefined;
    res.json(await command(user.id, message, image));
  } catch (err) {
    next(err);
  }
});

// ─── Execute confirmed action ────────────────────────────────────────────────

const ExecuteBody = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});

router.post("/execute", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ExecuteBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("name is required.");

    const { name, args = {} } = parsed.data;

    let result: { ok: boolean; message: string; data?: unknown } = { ok: false, message: `Unknown action: ${name}` };

    switch (name) {
      case "play_spotify": {
        if (args.contextUri) {
          await playContext(user.id, String(args.contextUri));
        } else {
          await resumePlayback(user.id);
        }
        result = { ok: true, message: "Playing on Spotify." };
        break;
      }
      case "search_and_play_spotify": {
        const q = String(args.query ?? "");
        const type = String(args.type ?? "track,playlist");
        const results = await search(user.id, q, type);
        const uri = results.playlists[0]?.uri ?? results.tracks[0]?.uri;
        if (uri) {
          if (uri.includes(":playlist:") || uri.includes(":album:")) await playContext(user.id, uri);
          else await playTrack(user.id, uri);
          result = { ok: true, message: `Playing "${q}" on Spotify.` };
        } else {
          result = { ok: false, message: `No results found for "${q}".` };
        }
        break;
      }
      case "pause_spotify": {
        await pausePlayback(user.id);
        result = { ok: true, message: "Playback paused." };
        break;
      }
      case "skip_spotify": {
        await skipToNext(user.id);
        result = { ok: true, message: "Skipped to next track." };
        break;
      }
      case "get_weather": {
        const location = String(args.location ?? "");
        // For simplicity, return a message asking for coordinates (app should resolve location)
        result = { ok: true, message: `Weather check requested for ${location}.`, data: { location } };
        break;
      }
      case "get_fitness_summary": {
        const summary = await getDailySummary(user.id);
        result = {
          ok: true,
          message: `Today: ${summary.steps.toLocaleString()} steps, ${summary.caloriesBurned} calories, ${summary.activeMinutes} active minutes.`,
          data: summary,
        };
        break;
      }
      case "create_google_task": {
        const lists = await getTaskLists(user.id);
        const listId = lists[0]?.id;
        if (!listId) { result = { ok: false, message: "No Google Task lists found." }; break; }
        const task = await createGoogleTask(user.id, listId, {
          title: String(args.title ?? "New task"),
          notes: args.notes ? String(args.notes) : undefined,
          due: args.due ? String(args.due) : undefined,
        });
        result = { ok: true, message: `Task created: "${task.title}"`, data: task };
        break;
      }
      case "list_google_tasks": {
        const lists = await getTaskLists(user.id);
        const listId = lists[0]?.id;
        if (!listId) { result = { ok: false, message: "No Google Task lists found." }; break; }
        const tasks = await getTasksInList(user.id, listId);
        result = { ok: true, message: `You have ${tasks.length} pending tasks.`, data: tasks };
        break;
      }
      case "create_todoist_task": {
        const task = await createTodoistTask(user.id, {
          content: String(args.content ?? "New task"),
          dueString: args.dueString ? String(args.dueString) : undefined,
          priority: args.priority ? Number(args.priority) : undefined,
        });
        result = { ok: true, message: `Todoist task created: "${task.content}"`, data: task };
        break;
      }
      case "create_notion_note": {
        // Notion requires a parentId — return a prompt for the user to select a page
        result = { ok: false, message: "To create a Notion note, please select a parent page from the Notion section in Connected Accounts." };
        break;
      }
      case "get_calendar_events": {
        const days = args.days ? Number(args.days) : 7;
        const from = new Date().toISOString();
        const to = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        const events = await getUserEvents(user.id, from, to);
        const upcoming = events.slice(0, 5).map((e) => {
          const when = e.startTime.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
          return `${e.title} — ${when}`;
        });
        result = {
          ok: true,
          message: events.length === 0
            ? `No events in the next ${days} day${days === 1 ? "" : "s"}.`
            : `You have ${events.length} event${events.length === 1 ? "" : "s"} coming up:\n${upcoming.join("\n")}`,
          data: { count: events.length },
        };
        break;
      }
      case "get_gmail_inbox": {
        result = { ok: true, message: "Opening your Gmail inbox.", data: { action: "open_inbox" } };
        break;
      }
      default:
        result = { ok: false, message: `Action "${name}" is not yet supported.` };
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
