/**
 * Personal Mode Gemini Assistant.
 *
 * Mirrors the accountant assistant pattern but for personal life automation.
 * Uses Gemini with function-calling across all connected personal integrations.
 * System prompt is profession-aware (reads user's personal persona from profession_profiles).
 */

import { randomUUID } from "crypto";
import { query } from "../../config/db";
import { geminiGenerateContent, type GeminiPart, type GeminiToolFunction } from "../ai/geminiClient";

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
  const res = await query<{ persona: string }>(
    `SELECT persona FROM profession_profiles WHERE user_id = $1 AND mode = 'personal'`,
    [userId],
  );
  return res.rows[0]?.persona ?? "general";
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

export async function command(
  userId: string,
  message: string,
  image?: { mimeType: string; data: string },
): Promise<PersonalCommandResult> {
  const persona = await getPersonalPersona(userId);
  const systemPrompt = buildSystemPrompt(persona);

  // Multimodal: when an image is attached, pass it alongside the text prompt as
  // an inline_data part so Gemini can reason about it (receipts, screenshots, …).
  const parts: GeminiPart[] = image
    ? [{ text: message }, { inlineData: { mimeType: image.mimeType, data: image.data } }]
    : [{ text: message }];

  let isLive = false;
  try {
    const result = await geminiGenerateContent({
      system: systemPrompt,
      parts,
      json: false,
      tools: PERSONAL_TOOLS,
    });

    isLive = true;

    if (result.functionCall) {
      const { name, args } = result.functionCall;
      const needsConfirm = !READ_ONLY_ACTIONS.has(name);
      return {
        answer: result.raw?.trim() || null,
        action: {
          id: randomUUID(),
          name,
          args,
          summary: summarizeAction(name, args),
          needsConfirm,
        },
        isLive,
      };
    }

    return { answer: result.raw?.trim() || "I'm not sure how to help with that.", action: null, isLive };
  } catch {
    return {
      answer: "I'm having trouble connecting right now. Please try again.",
      action: null,
      isLive: false,
    };
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

  await query(
    `INSERT INTO personal_chat_messages (user_id, role, content) VALUES ($1, 'user', $2)`,
    [userId, message],
  ).catch(() => {});

  try {
    const result = await geminiGenerateContent({
      system: systemPrompt,
      parts: [{ text: userPrompt }],
      json: false,
      maxOutputTokens: 1024,
    });

    const answer = result.raw?.trim() || "I'm not sure about that.";

    await query(
      `INSERT INTO personal_chat_messages (user_id, role, content) VALUES ($1, 'assistant', $2)`,
      [userId, answer],
    ).catch(() => {});

    return { answer, isFallback: false };
  } catch {
    return { answer: "I'm having trouble connecting right now. Please try again.", isFallback: true };
  }
}

export async function getChatHistory(userId: string): Promise<PersonalChatTurn[]> {
  const res = await query<{ role: "user" | "assistant"; content: string }>(
    `SELECT role, content FROM personal_chat_messages WHERE user_id = $1 ORDER BY created_at ASC LIMIT 50`,
    [userId],
  ).catch(() => ({ rows: [] }));
  return res.rows.map((r) => ({ role: r.role, content: r.content }));
}
