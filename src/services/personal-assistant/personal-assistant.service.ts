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
import { createTask as createTodoistTask, getTasks as getTodoistTasks } from "../todoist/todoist.service";
import { getUserEvents } from "../events.service";
import { isConnected, listIntegrationsForUser } from "../integrations/tokenStore";
import { listGmailMailboxMessages } from "../googleApi.service";
import { searchPages as searchNotionPages, getPageContent, createPage as createNotionPage } from "../notion/notion.service";
import { getChannels as getSlackChannels, postMessage as postSlackMessage } from "../slack/slack.service";
import { getRepos as getGitHubRepos, getIssues as getGitHubIssues, getPullRequests as getGitHubPullRequests, createIssue as createGitHubIssue } from "../pm/github.service";
import { getProjects as getJiraProjects, searchIssues as searchJiraIssues, createIssue as createJiraIssue } from "../jira/jira.service";
import { getBoards as getTrelloBoards, getListsForBoard, getCardsForBoard, createCard as createTrelloCard } from "../pm/trello.service";

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

export const CONNECTED_APP_ORCHESTRATION_PROMPT = [
  "Connected-app workflow rules:",
  "- Treat broad or vague requests as workflow requests. Infer the user's likely goal from the current prompt, conversation history, persona, and connected apps.",
  "- Prefer useful discovery over asking a question. If an app-specific ID is missing, call the relevant list/search tool first, then use the result in the follow-up turn.",
  "- Pick the most appropriate connected app automatically: code work maps to GitHub/Jira/Slack, planning notes to Notion/Trello/Jira, tasks to Google Tasks/Todoist/Trello/Jira, team updates to Slack, music to Spotify, email questions to Gmail.",
  "- For multi-app requests, choose the first concrete step that unlocks the workflow, such as listing Slack channels before posting or listing Trello lists before creating a card.",
  "- Never invent IDs, repositories, channels, boards, pages, projects, or issue keys. Use discovery tools or ask only when discovery cannot resolve it.",
  "- Call exactly one function per assistant turn. The app asks the user to confirm write actions before execution.",
].join("\n");

function buildSystemPrompt(persona: string): string {
  const professionCtx = PROFESSION_CONTEXT[persona] ?? PROFESSION_CONTEXT.general;
  return `You are Interlink Personal Assistant — an AI that automates the user's personal life.
${professionCtx}

You have access to tools across the user's connected apps: Google Calendar/Gmail/Tasks,
Spotify, Todoist, Notion, Slack, GitHub, Jira, and Trello.
${CONNECTED_APP_ORCHESTRATION_PROMPT}

When the user asks you to do something, determine whether you can answer directly or need to call a tool.
If calling a tool, return ONLY a function call. If answering, return a concise helpful response.
Always be direct and action-oriented.`;
}

// ─── Tool declarations ────────────────────────────────────────────────────────

export const PERSONAL_TOOLS: GeminiToolFunction[] = [
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
    name: "list_todoist_tasks",
    description: "List open Todoist tasks.",
    parameters: { type: "object", properties: {}, required: [] },
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
        query: { type: "string", description: "Optional Gmail search query." },
      },
      required: [],
    },
  },
  {
    name: "search_gmail_messages",
    description: "Search recent Gmail inbox messages.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query." },
        limit: { type: "number", description: "Number of emails to return (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_notion_pages",
    description: "Search connected Notion pages by title or content query.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search text. Empty string lists recent pages." } },
      required: [],
    },
  },
  {
    name: "read_notion_page",
    description: "Read plain-text content from a Notion page by page id.",
    parameters: {
      type: "object",
      properties: { pageId: { type: "string", description: "Notion page id." } },
      required: ["pageId"],
    },
  },
  {
    name: "post_slack_message",
    description: "Post a message to a Slack channel.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Slack channel id, for example C123. Use list_slack_channels first if unknown." },
        text: { type: "string", description: "Message to send." },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "list_slack_channels",
    description: "List Slack channels available to the connected Slack app.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_github_repos",
    description: "List connected GitHub repositories.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_github_issues",
    description: "List open GitHub issues for a repository.",
    parameters: {
      type: "object",
      properties: { repo: { type: "string", description: "Repository as owner/name." } },
      required: ["repo"],
    },
  },
  {
    name: "list_github_pull_requests",
    description: "List open GitHub pull requests for a repository.",
    parameters: {
      type: "object",
      properties: { repo: { type: "string", description: "Repository as owner/name." } },
      required: ["repo"],
    },
  },
  {
    name: "create_github_issue",
    description: "Create a GitHub issue in a repository.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository as owner/name." },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["repo", "title"],
    },
  },
  {
    name: "list_jira_projects",
    description: "List connected Jira projects.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_jira_issues",
    description: "Search Jira issues using JQL, or omit JQL for current user's unresolved issues.",
    parameters: {
      type: "object",
      properties: { jql: { type: "string", description: "Optional JQL search string." } },
      required: [],
    },
  },
  {
    name: "create_jira_issue",
    description: "Create a Jira issue.",
    parameters: {
      type: "object",
      properties: {
        projectKey: { type: "string", description: "Jira project key." },
        summary: { type: "string" },
        description: { type: "string" },
        issueType: { type: "string", description: "Issue type, defaults to Task." },
      },
      required: ["projectKey", "summary"],
    },
  },
  {
    name: "list_trello_boards",
    description: "List connected Trello boards.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_trello_cards",
    description: "List open Trello cards for a board.",
    parameters: {
      type: "object",
      properties: { boardId: { type: "string", description: "Trello board id." } },
      required: ["boardId"],
    },
  },
  {
    name: "list_trello_lists",
    description: "List Trello lists for a board so cards can be created in the right list.",
    parameters: {
      type: "object",
      properties: { boardId: { type: "string", description: "Trello board id." } },
      required: ["boardId"],
    },
  },
  {
    name: "create_trello_card",
    description: "Create a Trello card in a list.",
    parameters: {
      type: "object",
      properties: {
        listId: { type: "string", description: "Trello list id. Use list_trello_lists first if unknown." },
        name: { type: "string" },
        desc: { type: "string" },
        due: { type: "string", description: "Optional due date." },
      },
      required: ["listId", "name"],
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

export async function connectedAppsSummary(userId: string): Promise<string> {
  try {
    const integrations = await listIntegrationsForUser(userId);
    const active = integrations.filter((i) => i.status === "active").map((i) => i.provider).sort();
    if (active.length === 0) return "Connected apps: none.";
    return `Connected apps: ${active.join(", ")}.`;
  } catch (err) {
    logger.warn("[personal-assistant] connectedAppsSummary failed", { err: String(err) });
    return "Connected apps: unavailable.";
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

const DEFAULT_SPOTIFY_SEARCH_TYPES = "track,album,playlist";

function normalizeSpotifySearchTypes(value: unknown): string {
  const raw = String(value ?? "").toLowerCase().trim();
  if (!raw) return DEFAULT_SPOTIFY_SEARCH_TYPES;

  const aliases: Record<string, string> = {
    song: "track",
    songs: "track",
    track: "track",
    tracks: "track",
    album: "album",
    albums: "album",
    playlist: "playlist",
    playlists: "playlist",
  };
  const types = raw
    .split(",")
    .map((part) => aliases[part.trim()])
    .filter((part): part is string => Boolean(part));
  return [...new Set(types)].join(",") || DEFAULT_SPOTIFY_SEARCH_TYPES;
}

async function searchAndPlaySpotify(userId: string, queryText: string, rawType?: unknown): Promise<ExecuteResult> {
  const q = queryText.trim();
  if (!q) return { ok: false, message: "Tell me what song, album, or playlist to play on Spotify." };

  const searchTypes = normalizeSpotifySearchTypes(rawType);
  const results = await spotifySearch(userId, q, searchTypes);
  const requestedTypes = searchTypes.split(",");
  const playlistFirst = requestedTypes.length === 1 && requestedTypes[0] === "playlist";
  const albumFirst = requestedTypes.length === 1 && requestedTypes[0] === "album";

  const match =
    playlistFirst ? results.playlists[0] ?? results.tracks[0] ?? results.albums[0]
    : albumFirst ? results.albums[0] ?? results.tracks[0] ?? results.playlists[0]
    : results.tracks[0] ?? results.albums[0] ?? results.playlists[0];

  if (!match?.uri) return { ok: false, message: `No Spotify results found for "${q}".` };

  if (match.uri.includes(":playlist:") || match.uri.includes(":album:")) await playContext(userId, match.uri);
  else await playTrack(userId, match.uri);

  return { ok: true, message: `Playing "${match.name || q}" on Spotify.` };
}

function splitRepo(full: unknown): { owner: string; repo: string } | null {
  const [owner, repo] = String(full ?? "").trim().split("/");
  return owner && repo ? { owner, repo } : null;
}

function linesOrNone<T>(items: T[], mapper: (item: T) => string, none: string, limit = 8): string {
  if (items.length === 0) return none;
  return items.slice(0, limit).map(mapper).join("\n");
}

async function resolveNotionParent(userId: string, args: Record<string, unknown>): Promise<string | null> {
  const parentId = String(args.parentId ?? "").trim();
  if (parentId) return parentId;
  const parentQuery = String(args.parentQuery ?? args.parentTitle ?? "").trim();
  const pages = await searchNotionPages(userId, parentQuery);
  return pages[0]?.id ?? null;
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
        const contextUri = String(args.contextUri ?? "").trim();
        const q = String(args.query ?? "").trim();
        if (contextUri) await playContext(userId, contextUri);
        else if (q) return searchAndPlaySpotify(userId, q, args.type);
        else await resumePlayback(userId);
        return { ok: true, message: "Playing on Spotify." };
      }
      case "search_and_play_spotify": {
        return searchAndPlaySpotify(userId, String(args.query ?? ""), args.type);
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
      case "list_todoist_tasks": {
        const tasks = await getTodoistTasks(userId);
        const message = linesOrNone(
          tasks,
          (t) => `- ${t.content}${t.due?.string ? ` - ${t.due.string}` : ""}`,
          "No open Todoist tasks found.",
        );
        return { ok: true, message, data: tasks };
      }
      case "create_todoist_task": {
        const task = await createTodoistTask(userId, {
          content: String(args.content ?? "New task"),
          dueString: args.dueString ? String(args.dueString) : undefined,
          priority: args.priority ? Number(args.priority) : undefined,
        });
        return { ok: true, message: `Added to Todoist: "${task.content}".`, data: task };
      }
      case "search_notion_pages": {
        const pages = await searchNotionPages(userId, String(args.query ?? ""));
        const message = linesOrNone(pages, (p) => `- ${p.title} (${p.id})`, "No Notion pages found.");
        return { ok: true, message, data: pages };
      }
      case "read_notion_page": {
        const pageId = String(args.pageId ?? "").trim();
        if (!pageId) return { ok: false, message: "Notion pageId is required." };
        const content = await getPageContent(userId, pageId);
        return { ok: true, message: content || "That Notion page has no readable text content.", data: { content } };
      }
      case "create_notion_note": {
        if (!(await isConnected(userId, "notion"))) {
          return { ok: false, message: "Notion is not connected. Connect it from Settings → Connected Accounts." };
        }
        const parentId = await resolveNotionParent(userId, args);
        if (!parentId) {
          return { ok: false, message: "Tell me the Notion parent page, or search Notion pages first and pass a parentId." };
        }
        const page = await createNotionPage(userId, {
          parentId,
          title: String(args.title ?? "Interlink note"),
          content: args.content ? String(args.content) : undefined,
        });
        return { ok: true, message: `Created Notion page: "${page.title}".`, data: page };
      }
      case "list_slack_channels": {
        const channels = await getSlackChannels(userId);
        const message = linesOrNone(
          channels,
          (c) => `- #${c.name} (${c.id})${c.isMember ? "" : " - app not joined"}`,
          "No Slack channels are available.",
          12,
        );
        return { ok: true, message, data: channels };
      }
      case "post_slack_message": {
        const channel = String(args.channel ?? "").trim();
        const text = String(args.text ?? "").trim();
        if (!channel || !text) return { ok: false, message: "Slack channel and text are required." };
        await postSlackMessage(userId, channel, text);
        return { ok: true, message: "Posted the message to Slack." };
      }
      case "list_github_repos": {
        const repos = await getGitHubRepos(userId);
        const message = linesOrNone(repos, (r) => `- ${r.fullName} - ${r.openIssues} open issues`, "No GitHub repositories found.", 12);
        return { ok: true, message, data: repos };
      }
      case "list_github_issues": {
        const repoParts = splitRepo(args.repo);
        if (!repoParts) return { ok: false, message: "Specify a GitHub repo as owner/name." };
        const issues = await getGitHubIssues(userId, repoParts.owner, repoParts.repo);
        const message = linesOrNone(issues, (i) => `- #${i.number} ${i.title}`, "No open GitHub issues found.");
        return { ok: true, message, data: issues };
      }
      case "list_github_pull_requests": {
        const repoParts = splitRepo(args.repo);
        if (!repoParts) return { ok: false, message: "Specify a GitHub repo as owner/name." };
        const prs = await getGitHubPullRequests(userId, repoParts.owner, repoParts.repo);
        const message = linesOrNone(prs, (p) => `- #${p.number} ${p.title} (${p.author})`, "No open GitHub pull requests found.");
        return { ok: true, message, data: prs };
      }
      case "create_github_issue": {
        const repoParts = splitRepo(args.repo);
        if (!repoParts) return { ok: false, message: "Specify a GitHub repo as owner/name." };
        const issue = await createGitHubIssue(userId, repoParts.owner, repoParts.repo, {
          title: String(args.title ?? "").trim(),
          body: args.body ? String(args.body) : undefined,
        });
        return { ok: true, message: `Created GitHub issue #${issue.number}: ${issue.title}.`, data: issue };
      }
      case "list_jira_projects": {
        const projects = await getJiraProjects(userId);
        const message = linesOrNone(projects, (p) => `- ${p.key} - ${p.name}`, "No Jira projects found.", 12);
        return { ok: true, message, data: projects };
      }
      case "search_jira_issues": {
        const issues = await searchJiraIssues(userId, args.jql ? String(args.jql) : undefined);
        const message = linesOrNone(issues, (i) => `- ${i.key} ${i.summary} - ${i.status}`, "No Jira issues found.", 12);
        return { ok: true, message, data: issues };
      }
      case "create_jira_issue": {
        const issue = await createJiraIssue(userId, {
          projectKey: String(args.projectKey ?? "").trim(),
          summary: String(args.summary ?? "").trim(),
          description: args.description ? String(args.description) : undefined,
          issueType: args.issueType ? String(args.issueType) : undefined,
        });
        return { ok: true, message: `Created Jira issue ${issue.key}: ${issue.summary}.`, data: issue };
      }
      case "list_trello_boards": {
        const boards = await getTrelloBoards(userId);
        const message = linesOrNone(boards, (b) => `- ${b.name} (${b.id})`, "No Trello boards found.", 12);
        return { ok: true, message, data: boards };
      }
      case "list_trello_lists": {
        const boardId = String(args.boardId ?? "").trim();
        if (!boardId) return { ok: false, message: "Trello boardId is required." };
        const lists = await getListsForBoard(userId, boardId);
        const message = linesOrNone(lists, (l) => `- ${l.name} (${l.id})`, "No Trello lists found.", 12);
        return { ok: true, message, data: lists };
      }
      case "list_trello_cards": {
        const boardId = String(args.boardId ?? "").trim();
        if (!boardId) return { ok: false, message: "Trello boardId is required." };
        const cards = await getCardsForBoard(userId, boardId);
        const message = linesOrNone(cards, (c) => `- ${c.name}${c.due ? ` - due ${c.due}` : ""}`, "No open Trello cards found.", 12);
        return { ok: true, message, data: cards };
      }
      case "create_trello_card": {
        const listId = String(args.listId ?? "").trim();
        const nameText = String(args.name ?? "").trim();
        if (!listId || !nameText) return { ok: false, message: "Trello listId and name are required." };
        const card = await createTrelloCard(userId, listId, {
          name: nameText,
          desc: args.desc ? String(args.desc) : undefined,
          due: args.due ? String(args.due) : undefined,
        });
        return { ok: true, message: `Created Trello card: "${card.name}".`, data: card };
      }
      case "get_gmail_inbox":
      case "search_gmail_messages": {
        const messages = await listGmailMailboxMessages({
          userId,
          mailbox: "inbox",
          maxResults: args.limit ? Number(args.limit) : 10,
          query: args.query ? String(args.query) : undefined,
        });
        const message = linesOrNone(
          messages,
          (m) => `- ${m.subject ?? "(no subject)"} - ${m.from ?? "unknown sender"}`,
          "No Gmail messages found.",
          10,
        );
        return { ok: true, message, data: messages };
      }
      default:
        return { ok: false, message: `Action "${name}" isn't supported yet.` };
    }
  } catch (err) {
    logger.error("[personal-assistant] executeAction failed", { name, err: String(err) });
    return { ok: false, message: err instanceof Error ? err.message : "That action failed." };
  }
}

// ─── Command (function-calling) ───────────────────────────────────────────────

export function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "play_spotify": return `Play ${args.query ? `"${args.query}"` : "music"} on Spotify`;
    case "pause_spotify": return "Pause Spotify playback";
    case "skip_spotify": return "Skip to next track";
    case "search_and_play_spotify": return `Search and play "${args.query}" on Spotify`;
    case "create_google_task": return `Create task: "${args.title}"`;
    case "list_todoist_tasks": return "List Todoist tasks";
    case "create_todoist_task": return `Add to Todoist: "${args.content}"`;
    case "search_notion_pages": return `Search Notion for "${args.query ?? ""}"`;
    case "read_notion_page": return "Read a Notion page";
    case "create_notion_note": return `Create Notion note: "${args.title}"`;
    case "list_slack_channels": return "List Slack channels";
    case "post_slack_message": return `Post a message to Slack`;
    case "list_github_repos": return "List GitHub repositories";
    case "list_github_issues": return `List GitHub issues in ${args.repo ?? "a repo"}`;
    case "list_github_pull_requests": return `List GitHub pull requests in ${args.repo ?? "a repo"}`;
    case "create_github_issue": return `Create GitHub issue "${args.title ?? ""}"`;
    case "list_jira_projects": return "List Jira projects";
    case "search_jira_issues": return "Search Jira issues";
    case "create_jira_issue": return `Create Jira issue "${args.summary ?? ""}"`;
    case "list_trello_boards": return "List Trello boards";
    case "list_trello_lists": return "List Trello lists";
    case "list_trello_cards": return "List Trello cards";
    case "create_trello_card": return `Create Trello card "${args.name ?? ""}"`;
    case "get_weather": return `Get weather for ${args.location}`;
    case "get_fitness_summary": return "Check today's fitness stats";
    case "search_gmail_messages": return `Search Gmail for "${args.query ?? ""}"`;
    case "get_gmail_inbox": return "Check Gmail inbox";
    default: return `Run ${name}`;
  }
}

export const READ_ONLY_ACTIONS = new Set([
  "get_weather",
  "get_fitness_summary",
  "get_gmail_inbox",
  "search_gmail_messages",
  "get_calendar_events",
  "list_google_tasks",
  "list_todoist_tasks",
  "search_notion_pages",
  "read_notion_page",
  "list_slack_channels",
  "list_github_repos",
  "list_github_issues",
  "list_github_pull_requests",
  "list_jira_projects",
  "search_jira_issues",
  "list_trello_boards",
  "list_trello_lists",
  "list_trello_cards",
]);

export function isReadOnlyAction(name: string): boolean {
  return READ_ONLY_ACTIONS.has(name);
}

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
  const appsSummary = await connectedAppsSummary(userId);

  // Multimodal: when an image is attached, pass it alongside the text prompt as
  // an inline_data part so Gemini can reason about it (receipts, screenshots, …).
  const parts: GeminiPart[] = opts.image
    ? [{ text: appsSummary }, { text: message }, { inlineData: { mimeType: opts.image.mimeType, data: opts.image.data } }]
    : [{ text: appsSummary }, { text: message }];

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
