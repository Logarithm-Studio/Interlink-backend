/**
 * Personal Mode Gemini Assistant.
 *
 * Mirrors the accountant assistant pattern but for personal life automation.
 * Uses Gemini with function-calling across all connected personal integrations.
 * System prompt is profession-aware (reads user's personal persona from profession_profiles).
 */

import { randomUUID } from "crypto";
import { query } from "../../config/db";
import { logger } from "../../observability/logger";
import {
  geminiGenerateContent,
  isGeminiLive,
  type GeminiPart,
  type GeminiToolFunction,
} from "../ai/geminiClient";

// Integration services used by executeAction (function dispatch).
import {
  resumePlayback,
  pausePlayback,
  skipToNext,
  search as spotifySearch,
  playContext,
  playTrack,
} from "../spotify/spotify.service";
import { getCurrentWeather } from "../weather/weather.service";
import { getDailySummary } from "../fitness/fitness.service";
import { getTaskLists, getTasksInList, createTask as createGoogleTask } from "../tasks/tasks.service";
import { createTask as createTodoistTask } from "../todoist/todoist.service";
import { getUserEvents } from "../events.service";

// ─── Profession-aware system prompts ─────────────────────────────────────────

const PROFESSION_CONTEXT: Record<string, string> = {
  developer: "The user is a software developer. Prioritize GitHub PRs, coding tasks, and technical work. For music suggestions, default to focus/coding playlists. When calendar events involve 'standup', 'review', or 'sprint', treat them as high-priority.",
  designer: "The user is a designer/creative professional. Prioritize creative tasks, portfolio reviews, and client presentations in their calendar.",
  student: "The user is a student. Prioritize assignments and study sessions. Use due dates on tasks as hard deadlines. Weather matters for campus commute.",
  healthcare_professional: "The user works in healthcare. Prioritize patient-related scheduling, fitness metrics, and work-life balance. Be sensitive about sensitive medical context.",
  business_professional: "The user is a business professional. Prioritize meetings, client calls, and action items. Suggest productivity-focused music.",
  freelancer: "The user is a freelancer. Balance client work with personal time. Track deadlines across Todoist and Calendar carefully.",
  creative: "The user is in a creative field. Support inspiration-seeking, idea capture to Notion, and flexible scheduling.",
  educator: "The user is an educator. Prioritize class schedules, grading deadlines, and student communication.",
  general: "Help the user manage their personal life efficiently across calendar, tasks, notes, music, and fitness.",
};

function buildSystemPrompt(persona: string): string {
  const professionCtx = PROFESSION_CONTEXT[persona] ?? PROFESSION_CONTEXT.general;
  return `You are Interlink Personal Assistant — an AI that automates the user's personal life.
${professionCtx}

You have access to the following tools: get_calendar_events, get_weather, play_spotify, pause_spotify,
skip_spotify, search_and_play_spotify, create_google_task, list_google_tasks,
create_todoist_task, create_notion_note, get_fitness_summary, get_gmail_inbox.

When the user asks you to do something, determine whether you can answer directly or need to call a tool.
If calling a tool, return ONLY a function call. If answering, return a concise helpful response.
Always be direct and action-oriented.`;
}

// ─── Tool declarations ────────────────────────────────────────────────────────

const PERSONAL_TOOLS: GeminiToolFunction[] = [
  {
    name: "get_calendar_events",
    description: "Get the user's upcoming calendar events. Use when asked about schedule, calendar, upcoming meetings, etc.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of days ahead to look (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "get_weather",
    description: "Get current weather or forecast for a location.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name or coordinates" },
        days: { type: "number", description: "Forecast days (1-7)" },
      },
      required: ["location"],
    },
  },
  {
    name: "play_spotify",
    description: "Play music on Spotify. Can play a playlist, album, or resume playback.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to play (playlist name, genre, mood, or artist)" },
        contextUri: { type: "string", description: "Spotify URI if known" },
      },
      required: [],
    },
  },
  {
    name: "pause_spotify",
    description: "Pause Spotify playback.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "skip_spotify",
    description: "Skip to the next track on Spotify.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_and_play_spotify",
    description: "Search Spotify and play the top result.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (track name, artist, playlist)" },
        type: { type: "string", enum: ["track", "playlist", "album"], description: "Type to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_google_task",
    description: "Create a task in Google Tasks.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        notes: { type: "string", description: "Optional notes or description" },
        due: { type: "string", description: "Due date in RFC 3339 format (optional)" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_google_tasks",
    description: "List incomplete tasks from Google Tasks.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_todoist_task",
    description: "Create a task in Todoist.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Task content/title" },
        dueString: { type: "string", description: "Natural language due date, e.g. 'tomorrow', 'next Monday'" },
        priority: { type: "number", description: "Priority 1-4 (4 = highest/red)" },
      },
      required: ["content"],
    },
  },
  {
    name: "create_notion_note",
    description: "Create a note or page in Notion.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title" },
        content: { type: "string", description: "Note body content" },
      },
      required: ["title"],
    },
  },
  {
    name: "get_fitness_summary",
    description: "Get today's fitness summary (steps, calories, active minutes).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_gmail_inbox",
    description: "Get recent emails from Gmail inbox.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of emails to return (default 10)" },
      },
      required: [],
    },
  },
];

// ─── Chat types ───────────────────────────────────────────────────────────────

export interface PersonalChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface PersonalCommandResult {
  answer: string | null;
  action: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    summary: string;
    needsConfirm: boolean;
  } | null;
  isLive: boolean;
}

export interface PersonalChatResult {
  answer: string;
  isFallback: boolean;
}

// ─── Get persona for user ─────────────────────────────────────────────────────

async function getPersonalPersona(userId: string): Promise<string> {
  try {
    const res = await query<{ persona: string }>(
      `SELECT persona FROM profession_profiles WHERE user_id = $1 AND mode = 'personal'`,
      [userId],
    );
    return res.rows[0]?.persona ?? "general";
  } catch (err) {
    logger.warn("[personal-assistant] getPersonalPersona failed, defaulting to general", { err: String(err) });
    return "general";
  }
}

async function persistMessage(userId: string, role: "user" | "assistant", content: string): Promise<void> {
  if (!content) return;
  try {
    await query(
      `INSERT INTO personal_chat_messages (user_id, role, content) VALUES ($1, $2, $3)`,
      [userId, role, content],
    );
  } catch (err) {
    logger.warn("[personal-assistant] failed to persist chat message", { err: String(err) });
  }
}

// ─── Action execution (function dispatch) ──────────────────────────────────────

export interface ExecuteContext {
  /** Caller's current coordinates, used by location-aware actions (weather). */
  lat?: number;
  lon?: number;
}

export interface ExecuteResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

/**
 * Execute a single personal-assistant action. Used both for confirmed write
 * actions (via /execute) and for auto-running read-only actions inside command().
 * Always resolves (never throws) so the assistant can report failures cleanly.
 */
export async function executeAction(
  userId: string,
  name: string,
  args: Record<string, unknown> = {},
  ctx: ExecuteContext = {},
): Promise<ExecuteResult> {
  try {
    switch (name) {
      case "play_spotify": {
        if (args.contextUri) await playContext(userId, String(args.contextUri));
        else await resumePlayback(userId);
        return { ok: true, message: "Playing on Spotify." };
      }
      case "search_and_play_spotify": {
        const q = String(args.query ?? "");
        const type = String(args.type ?? "track,playlist");
        const results = await spotifySearch(userId, q, type);
        const uri = results.playlists[0]?.uri ?? results.tracks[0]?.uri;
        if (!uri) return { ok: false, message: `No Spotify results for "${q}".` };
        if (uri.includes(":playlist:") || uri.includes(":album:")) await playContext(userId, uri);
        else await playTrack(userId, uri);
        return { ok: true, message: `Playing "${q}" on Spotify.` };
      }
      case "pause_spotify":
        await pausePlayback(userId);
        return { ok: true, message: "Playback paused." };
      case "skip_spotify":
        await skipToNext(userId);
        return { ok: true, message: "Skipped to the next track." };
      case "get_weather": {
        if (ctx.lat == null || ctx.lon == null) {
          return { ok: false, message: "I need your location to check the weather. Enable location access and try again." };
        }
        const w = await getCurrentWeather(ctx.lat, ctx.lon);
        return {
          ok: true,
          message: `It's currently ${w.temp}°C and ${w.description}${w.isRain ? " — bring an umbrella" : ""}.`,
          data: w,
        };
      }
      case "get_fitness_summary": {
        const s = await getDailySummary(userId);
        return {
          ok: true,
          message: `Today you've taken ${s.steps.toLocaleString()} steps, burned ${s.caloriesBurned} calories, and logged ${s.activeMinutes} active minutes.`,
          data: s,
        };
      }
      case "get_calendar_events": {
        const days = args.days ? Number(args.days) : 7;
        const from = new Date().toISOString();
        const to = new Date(Date.now() + days * 86_400_000).toISOString();
        const events = await getUserEvents(userId, from, to);
        if (events.length === 0) {
          return { ok: true, message: `You have no events in the next ${days} day${days === 1 ? "" : "s"}.`, data: { count: 0 } };
        }
        const lines = events.slice(0, 5).map((e) => {
          const when = e.startTime.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
          return `• ${e.title} — ${when}`;
        });
        return {
          ok: true,
          message: `You have ${events.length} upcoming event${events.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
          data: { count: events.length },
        };
      }
      case "create_google_task": {
        const lists = await getTaskLists(userId);
        const listId = lists[0]?.id;
        if (!listId) return { ok: false, message: "No Google Task lists found. Connect Google Tasks first." };
        const task = await createGoogleTask(userId, listId, {
          title: String(args.title ?? "New task"),
          notes: args.notes ? String(args.notes) : undefined,
          due: args.due ? String(args.due) : undefined,
        });
        return { ok: true, message: `Task created: "${task.title}".`, data: task };
      }
      case "list_google_tasks": {
        const lists = await getTaskLists(userId);
        const listId = lists[0]?.id;
        if (!listId) return { ok: false, message: "No Google Task lists found. Connect Google Tasks first." };
        const tasks = await getTasksInList(userId, listId);
        if (tasks.length === 0) return { ok: true, message: "You're all caught up — no pending tasks.", data: [] };
        const lines = tasks.slice(0, 8).map((t) => `• ${t.title}`);
        return { ok: true, message: `You have ${tasks.length} pending task${tasks.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, data: tasks };
      }
      case "create_todoist_task": {
        const task = await createTodoistTask(userId, {
          content: String(args.content ?? "New task"),
          dueString: args.dueString ? String(args.dueString) : undefined,
          priority: args.priority ? Number(args.priority) : undefined,
        });
        return { ok: true, message: `Added to Todoist: "${task.content}".`, data: task };
      }
      case "create_notion_note":
        return { ok: false, message: "To save a Notion note, open Connected Accounts and pick a parent page first." };
      case "get_gmail_inbox":
        return { ok: true, message: "Opening your Gmail inbox.", data: { action: "open_inbox" } };
      default:
        return { ok: false, message: `Action "${name}" isn't supported yet.` };
    }
  } catch (err) {
    logger.error("[personal-assistant] executeAction failed", { name, err: String(err) });
    return { ok: false, message: err instanceof Error ? err.message : "That action failed." };
  }
}

// ─── Command (function-calling) ───────────────────────────────────────────────

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "play_spotify": return `Play ${args.query ? `"${args.query}"` : "music"} on Spotify`;
    case "pause_spotify": return "Pause Spotify playback";
    case "skip_spotify": return "Skip to next track";
    case "search_and_play_spotify": return `Search and play "${args.query}" on Spotify`;
    case "create_google_task": return `Create task: "${args.title}"`;
    case "create_todoist_task": return `Add to Todoist: "${args.content}"`;
    case "create_notion_note": return `Create Notion note: "${args.title}"`;
    case "get_weather": return `Get weather for ${args.location}`;
    case "get_fitness_summary": return "Check today's fitness stats";
    case "get_gmail_inbox": return "Check Gmail inbox";
    default: return `Run ${name}`;
  }
}

const READ_ONLY_ACTIONS = new Set(["get_weather", "get_fitness_summary", "get_gmail_inbox", "get_calendar_events", "list_google_tasks"]);

export interface CommandOptions {
  image?: { mimeType: string; data: string };
  /** Caller's coordinates for location-aware tools (weather). */
  lat?: number;
  lon?: number;
}

export async function command(
  userId: string,
  message: string,
  opts: CommandOptions = {},
): Promise<PersonalCommandResult> {
  // Fail fast with a clear, actionable message when the AI isn't configured —
  // instead of a silent generic "trouble connecting".
  if (!isGeminiLive()) {
    const answer = "The AI assistant isn't configured yet. Add a GEMINI_API_KEY on the server to enable it.";
    await persistMessage(userId, "user", message);
    await persistMessage(userId, "assistant", answer);
    return { answer, action: null, isLive: false };
  }

  const persona = await getPersonalPersona(userId);
  const systemPrompt = buildSystemPrompt(persona);

  // Multimodal: when an image is attached, pass it alongside the text prompt as
  // an inline_data part so Gemini can reason about it (receipts, screenshots, …).
  const parts: GeminiPart[] = opts.image
    ? [{ text: message }, { inlineData: { mimeType: opts.image.mimeType, data: opts.image.data } }]
    : [{ text: message }];

  await persistMessage(userId, "user", message);

  try {
    const result = await geminiGenerateContent({
      system: systemPrompt,
      parts,
      json: false,
      tools: PERSONAL_TOOLS,
    });

    if (result.functionCall) {
      const { name, args } = result.functionCall;

      // Read-only actions run immediately and answer conversationally — no
      // confirmation round-trip — so the assistant feels like a real chat.
      if (READ_ONLY_ACTIONS.has(name)) {
        const exec = await executeAction(userId, name, args, { lat: opts.lat, lon: opts.lon });
        await persistMessage(userId, "assistant", exec.message);
        return { answer: exec.message, action: null, isLive: true };
      }

      // Write actions are returned for user confirmation before executing.
      const summary = summarizeAction(name, args);
      await persistMessage(userId, "assistant", summary);
      return {
        answer: result.raw?.trim() || null,
        action: { id: randomUUID(), name, args, summary, needsConfirm: true },
        isLive: true,
      };
    }

    const answer = result.raw?.trim() || "I'm not sure how to help with that.";
    await persistMessage(userId, "assistant", answer);
    return { answer, action: null, isLive: true };
  } catch (err) {
    logger.error("[personal-assistant] command failed", { err: String(err) });
    const answer = "I ran into a problem reaching the AI service. Please try again in a moment.";
    await persistMessage(userId, "assistant", answer);
    return { answer, action: null, isLive: false };
  }
}

// ─── Simple chat ─────────────────────────────────────────────────────────────

export async function chat(
  userId: string,
  message: string,
  history?: PersonalChatTurn[],
): Promise<PersonalChatResult> {
  const persona = await getPersonalPersona(userId);
  const systemPrompt = buildSystemPrompt(persona);

  const historyText = (history ?? [])
    .slice(-6)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");

  const userPrompt = historyText ? `${historyText}\nUser: ${message}` : message;

  if (!isGeminiLive()) {
    const answer = "The AI assistant isn't configured yet. Add a GEMINI_API_KEY on the server to enable it.";
    await persistMessage(userId, "user", message);
    await persistMessage(userId, "assistant", answer);
    return { answer, isFallback: true };
  }

  await persistMessage(userId, "user", message);

  try {
    const result = await geminiGenerateContent({
      system: systemPrompt,
      parts: [{ text: userPrompt }],
      json: false,
      maxOutputTokens: 1024,
    });

    const answer = result.raw?.trim() || "I'm not sure about that.";
    await persistMessage(userId, "assistant", answer);
    return { answer, isFallback: false };
  } catch (err) {
    logger.error("[personal-assistant] chat failed", { err: String(err) });
    const answer = "I ran into a problem reaching the AI service. Please try again in a moment.";
    await persistMessage(userId, "assistant", answer);
    return { answer, isFallback: true };
  }
}

export async function getChatHistory(userId: string): Promise<PersonalChatTurn[]> {
  try {
    const res = await query<{ role: "user" | "assistant"; content: string }>(
      `SELECT role, content FROM personal_chat_messages WHERE user_id = $1 ORDER BY created_at ASC LIMIT 50`,
      [userId],
    );
    return res.rows.map((r) => ({ role: r.role, content: r.content }));
  } catch (err) {
    logger.warn("[personal-assistant] getChatHistory failed", { err: String(err) });
    return [];
  }
}
