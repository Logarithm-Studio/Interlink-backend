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
import { runAgentTurn } from "../ai/agentLoop";

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
import {
  listDriveFiles,
  createDriveDoc,
  deleteDriveFile,
  shareDriveFile,
  findDriveFile,
  uploadDriveFile,
} from "../google/drive.service";
import { scheduleMeetMeeting } from "../google/meet.service";
import {
  searchYouTube,
  listYouTubePlaylists,
  createYouTubePlaylist,
  addToYouTubePlaylist,
  getLikedVideos,
} from "../google/youtube.service";
import {
  listOutlookMessages,
  sendOutlookMail,
  listOutlookEvents,
  createOutlookEvent,
  listTeamsChats,
  sendTeamsMessage,
  listOneDriveFiles,
  shareOneDriveFile,
} from "../microsoft/microsoft.service";
import { sendWhatsAppMessage } from "../whatsapp/twilio.service";
import {
  getTaskLists,
  getTasksInList,
  createTask as createGoogleTask,
  completeTask as completeGoogleTask,
  deleteTask as deleteGoogleTask,
} from "../tasks/tasks.service";
import { createTask as createTodoistTask, getTasks as getTodoistTasks } from "../todoist/todoist.service";
import { getUserEvents } from "../events.service";
import { isConnected, listIntegrationsForUser } from "../integrations/tokenStore";
import { getTokens } from "../auth.service";
import { listGmailMailboxMessages, sendAutomatedGmailMessage } from "../googleApi.service";
import { searchContacts, listContacts } from "../google/contacts.service";
import { searchPages as searchNotionPages, getPageContent, createPage as createNotionPage } from "../notion/notion.service";
import {
  getChannels as getSlackChannels,
  postMessage as postSlackMessage,
  getUsers as getSlackUsers,
  sendDirectMessage as sendSlackDirectMessage,
} from "../slack/slack.service";
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
  "- You can chain tools to finish a workflow in one turn. When an ID is missing (channel, board, list, repo, project, page), CALL the relevant discovery tool FIRST — its result is fed back to you in the same turn — then call the action tool with the resolved ID. Never ask the user for an ID you can look up.",
  "- Read/list/search tools run automatically as you chain. Only the final WRITE action (create/send/post/play) is shown to the user to confirm before it executes — so keep chaining until you reach that write, then emit it.",
  "- Pick the most appropriate connected app automatically: code work maps to GitHub/Jira/Slack, planning notes to Notion/Trello/Jira, tasks to Google Tasks/Todoist/Trello/Jira, team updates to Slack, music to Spotify, email questions to Gmail.",
  "- People by name: when a request names a person (invite, email, DM) but not their address, call search_contacts FIRST to resolve their email/handle, then act. Do this for EACH person named.",
  "- Act on MULTIPLES in one turn: an invite/email can go to several recipients at once (pass them all as a list), and Drive delete/share can take several files (via `names` or a `query`). Never make the user repeat themselves per person or per file.",
  "- To reach a person's Slack inbox use send_slack_dm (resolves them by name); use post_slack_message only for channels.",
  "- Never invent IDs, repositories, channels, boards, pages, projects, issue keys, or email addresses. Use discovery tools; only ask the user when discovery genuinely cannot resolve it.",
].join("\n");

/**
 * A "you are here in time" line fed every turn. Without it the model hallucinates the
 * date (it was scheduling meetings in 2024 / in the past). We prefer the client's clock
 * + timezone; fall back to the server's UTC clock so the *year* is at least correct.
 */
function buildNowContext(clientNow?: string, tz?: string): string {
  const iso = clientNow && !Number.isNaN(Date.parse(clientNow)) ? clientNow : new Date().toISOString();
  return [
    `CONTEXT — the current date and time is ${iso}${tz ? ` in timezone ${tz}` : ""}.`,
    `Resolve every relative date ("today", "tonight", "tomorrow", "next Monday", "in 2 hours") against this exact moment.`,
    `If the user gives no year, use the current year. NEVER schedule, create, or set anything in the past —`,
    `if a requested time has already passed, use the next future occurrence and say so.`,
    `When scheduling, interpret the user's stated time as their LOCAL wall-clock time: emit startTime/endTime as a plain`,
    `local datetime WITHOUT any "Z" or UTC offset (e.g. 2026-07-11T15:00:00), and${tz ? ` pass timeZone="${tz}"` : " pass the IANA timeZone"} so it lands correctly.`,
    `Do NOT convert times to UTC yourself.`,
  ].join(" ");
}

function buildSystemPrompt(persona: string): string {
  const professionCtx = PROFESSION_CONTEXT[persona] ?? PROFESSION_CONTEXT.general;
  return `You are Interlink — the user's personal AI chief of staff. You are the reasoning brain; Interlink's tools are your hands. Your job is to understand what the user actually wants and GET IT DONE across their connected apps — not to describe what you would do.
${professionCtx}

Apps you can act on (only when listed as connected in the "Connected apps" line each turn):
Google Calendar, Gmail, Google Tasks, Google Drive, Google Meet, Google Fit, YouTube, YouTube Music,
Outlook (mail + calendar), Microsoft Teams, OneDrive, WhatsApp (send only), Spotify, Todoist, Notion, Slack,
GitHub, Jira, Trello, and weather.
For music requests, prefer YouTube Music (search_youtube_music) — note it returns a link to open, it does not start playback on a device. Spotify can control playback only when the user's Spotify is properly authorized.
If the user asks about an app that isn't connected, say so briefly and offer to connect it — don't pretend.

How to think each turn (reason step by step, silently, then act):
1. Infer the real goal. Use the conversation history to resolve references like "it", "the other one", "that deal", "there".
2. Choose the app(s) and tool(s) that achieve it. For multi-step goals, chain discovery → action within the same turn.
3. Gather missing IDs with discovery tools BEFORE acting — never ask for an ID you can look up, and never invent one.
4. Act. Read/list/search tools answer immediately; write actions (create/send/post/play) are confirmed by the app.

${CONNECTED_APP_ORCHESTRATION_PROMPT}

Signature "life agent" behaviors — handle these proactively and thoroughly:
- "Prepare/plan my day" → read the calendar and tasks (plus weather/fitness if relevant), then give a prioritized, time-blocked plan and offer to reschedule conflicts.
- "Who should I follow up with?" → scan recent Gmail and calendar for stale or unanswered threads and suggest follow-ups (offer to draft them).
- Meeting / travel prep → check the next event and its timing, and flag if the user should leave soon.
- Life admin → surface tasks due, reminders, and anything time-sensitive, and offer to act on them.

Mapping examples (natural phrasing → tool):
- "play see you again" / "…on spotify" → search_and_play_spotify(query="see you again")
- "add milk to my todoist" → create_todoist_task(content="milk")
- "post to the team that the build is green" → list_slack_channels → post_slack_message(channel=<resolved id>, text=…)
- "what's on my calendar tomorrow" → get_calendar_events(days=1)
- "create a card 'ship v2' on my roadmap board" → list_trello_boards → list_trello_lists → create_trello_card(…)

Tone: warm, concise, and genuinely competent — like a sharp human assistant. Never robotic, never childish, never padded with disclaimers. Prefer doing over explaining.`;
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
    description:
      "Get the current weather for the user's location. The user's GPS coordinates are supplied automatically — just call this with no arguments for 'what's the weather'. Only pass location for a different named place.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "Optional city name for a place other than the user's current location." },
        days: { type: "number", description: "Forecast days (1-7)" },
      },
      required: [],
    },
  },
  {
    name: "play_spotify",
    description:
      "Resume playback or play a Spotify URI you already know. Use this ONLY to resume/continue or when you have an exact Spotify context URI. To play a named song, artist, album, or playlist, use search_and_play_spotify instead.",
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
    description:
      "Search Spotify for a named song, artist, album, or playlist and play the top result. Use this for any request like 'play <song>', 'play <song> on Spotify', 'play some <artist>', or 'put on <playlist>'.",
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
    name: "complete_google_task",
    description:
      "Mark a Google Task as done. Pass the task's title (or a distinctive part of it) — the matching open task is resolved automatically.",
    parameters: {
      type: "object",
      properties: { title: { type: "string", description: "Title (or part) of the task to complete." } },
      required: ["title"],
    },
  },
  {
    name: "delete_google_task",
    description: "Delete a Google Task by its title (or a distinctive part of it).",
    parameters: {
      type: "object",
      properties: { title: { type: "string", description: "Title (or part) of the task to delete." } },
      required: ["title"],
    },
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
    description: "Get today's fitness summary (steps, calories, active minutes) from Google Fit.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_drive_files",
    description: "List or search the user's Google Drive files. Pass a query to search by name; omit it to list recent files.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Optional name search text." } },
      required: [],
    },
  },
  {
    name: "create_drive_doc",
    description: "Create a new Google Doc in the user's Drive and return its link.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Document title." } },
      required: ["name"],
    },
  },
  {
    name: "delete_drive_file",
    description:
      "Move one or more Google Drive files to the trash. To delete several at once, pass `names` (a list) or a `query` that matches them all (e.g. 'invoice'); each match is resolved automatically.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "A single file name (or part) to delete." },
        names: { type: "array", items: { type: "string" }, description: "Several file names to delete in one go." },
        query: { type: "string", description: "Delete every non-trashed file whose name contains this text." },
        fileId: { type: "string", description: "Drive file id, if already known." },
      },
      required: [],
    },
  },
  {
    name: "share_drive_file",
    description:
      "Create shareable 'anyone with the link' view links for one or more Google Drive files. Pass a single `name`/`fileId`, or `names` (a list), or a `query` to share every match.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "A single file name (or part) to share." },
        names: { type: "array", items: { type: "string" }, description: "Several file names to share." },
        query: { type: "string", description: "Share every non-trashed file whose name contains this text." },
        fileId: { type: "string", description: "Drive file id, if already known." },
      },
      required: [],
    },
  },
  {
    name: "upload_to_drive",
    description:
      "Upload the file the user attached in this message to their Google Drive. Only call this when a file is attached. Optionally rename it.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Optional name to save the file as (defaults to its original name)." } },
      required: [],
    },
  },
  {
    name: "schedule_meet",
    description: "Schedule a Google Calendar event with a Google Meet video link and optional email invites.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Meeting title." },
        startTime: { type: "string", description: "Local start time WITHOUT offset/Z, e.g. 2026-07-11T15:00:00." },
        endTime: { type: "string", description: "Local end time WITHOUT offset/Z, e.g. 2026-07-11T16:00:00." },
        timeZone: { type: "string", description: "IANA timezone the start/end are in, e.g. Asia/Dhaka — use the one from the current-time context." },
        attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses (one or many)." },
        description: { type: "string", description: "Optional agenda/notes." },
      },
      required: ["title", "startTime", "endTime"],
    },
  },
  {
    name: "search_youtube",
    description: "Search YouTube for videos. Returns titles and links the user can open.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "search_youtube_music",
    description: "Search for a song/artist on YouTube Music and return YouTube Music links to play. NOTE: playback can't be started from the server — the user taps the link to play. Use this for 'play <song>' style music requests.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "list_youtube_playlists",
    description: "List the user's own YouTube playlists (id + title).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_youtube_liked",
    description: "List the user's liked YouTube videos.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_youtube_playlist",
    description: "Create a new (private) YouTube playlist.",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, description: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "add_to_youtube_playlist",
    description: "Add a video to one of the user's playlists. Resolve the playlistId with list_youtube_playlists and the videoId with search_youtube/search_youtube_music first.",
    parameters: {
      type: "object",
      properties: { playlistId: { type: "string" }, videoId: { type: "string" } },
      required: ["playlistId", "videoId"],
    },
  },
  {
    name: "send_gmail",
    description:
      "Send an email from the user's Gmail to one OR MORE recipients. Pass `to` as a list of email addresses (or names to resolve via search_contacts first). Use this for any 'email X' request; supports multiple people.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses (one or many)." },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "search_contacts",
    description:
      "Look up people in the user's Google Contacts by name (or email) to resolve their email address. Use this BEFORE inviting or emailing someone referred to only by name — including multiple people for one meeting.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "A person's name or partial email." } },
      required: ["query"],
    },
  },
  {
    name: "list_contacts",
    description: "List the user's saved Google Contacts (name + email).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_outlook_inbox",
    description: "Get recent emails from the user's Outlook (Microsoft 365) inbox.",
    parameters: { type: "object", properties: { limit: { type: "number", description: "How many to return (default 10)." } }, required: [] },
  },
  {
    name: "send_outlook_mail",
    description: "Send an email from the user's Outlook account.",
    parameters: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "list_outlook_events",
    description: "List upcoming events from the user's Outlook calendar.",
    parameters: { type: "object", properties: { limit: { type: "number" } }, required: [] },
  },
  {
    name: "create_outlook_event",
    description: "Create an event on the user's Outlook calendar with optional attendees.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string" },
        startTime: { type: "string", description: "ISO 8601 UTC start (e.g. 2026-07-07T09:00:00Z)." },
        endTime: { type: "string", description: "ISO 8601 UTC end." },
        attendees: { type: "array", items: { type: "string" } },
        body: { type: "string", description: "Optional agenda." },
      },
      required: ["subject", "startTime", "endTime"],
    },
  },
  {
    name: "list_teams_chats",
    description: "List the user's recent Microsoft Teams chats (to get a chat id to post to).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "send_teams_message",
    description: "Post a message to a Microsoft Teams chat by its id (use list_teams_chats first to resolve the id).",
    parameters: {
      type: "object",
      properties: { chatId: { type: "string" }, text: { type: "string" } },
      required: ["chatId", "text"],
    },
  },
  {
    name: "list_onedrive_files",
    description: "List or search the user's OneDrive files. Pass a query to search by name.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: [] },
  },
  {
    name: "share_onedrive_file",
    description: "Create a shareable view link for a OneDrive file by its id (use list_onedrive_files first).",
    parameters: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
  },
  {
    name: "send_whatsapp_message",
    description: "Send a WhatsApp message to a phone number (E.164 format, e.g. +8801XXXXXXXXX) via the user's Twilio WhatsApp sender.",
    parameters: {
      type: "object",
      properties: { to: { type: "string", description: "Recipient phone number in E.164 format." }, body: { type: "string", description: "Message text." } },
      required: ["to", "body"],
    },
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
    name: "list_slack_users",
    description: "List people in the user's Slack workspace (to DM someone by name).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "send_slack_dm",
    description:
      "Send a DIRECT message to a person in Slack (their inbox), not a channel. Pass the person's name — the matching workspace member is resolved automatically. Use this for 'DM/message <person>' requests.",
    parameters: {
      type: "object",
      properties: {
        user: { type: "string", description: "The person's name (or Slack username) to DM." },
        text: { type: "string", description: "Message to send." },
      },
      required: ["user", "text"],
    },
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

/**
 * A place the app should be able to jump to after (or instead of) reading a reply —
 * e.g. the Google Meet room just created, or the top YouTube result. `app` is a hint
 * the client uses to open the native app rather than a browser tab.
 */
export interface OpenLink {
  label: string;
  url: string;
  app:
    | "google-meet"
    | "google-calendar"
    | "google-drive"
    | "youtube"
    | "youtube-music"
    | "spotify"
    | "outlook"
    | "onedrive"
    | "web";
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
  /** Deep-link targets surfaced from any tool that ran this turn. */
  links?: OpenLink[];
  /** The conversation this turn was written to (new when the client sent none). */
  conversationId?: string;
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
  const apps: string[] = [];

  // Google-backed apps (Calendar, Gmail, Tasks, Fitness) are stored in a separate
  // table and never appear in listIntegrationsForUser — add them explicitly when the
  // user has a Google account so the model knows those tools are actually available.
  // A ReauthRequiredError still means an account row exists, so we list it either way.
  try {
    const google = await getTokens(userId, "google");
    if (google) apps.push("Google Calendar", "Gmail", "Google Tasks", "Google Drive", "Google Meet", "Google Fit", "YouTube", "YouTube Music");
  } catch {
    apps.push("Google Calendar", "Gmail", "Google Tasks", "Google Drive", "Google Meet", "Google Fit", "YouTube", "YouTube Music");
  }

  try {
    const integrations = await listIntegrationsForUser(userId);
    for (const i of integrations.filter((x) => x.status === "active")) {
      // One Microsoft connection unlocks several surfaces — name them so the model knows.
      if (i.provider === "microsoft") apps.push("Outlook (mail + calendar)", "Microsoft Teams", "OneDrive");
      else apps.push(i.provider);
    }
  } catch (err) {
    logger.warn("[personal-assistant] connectedAppsSummary failed", { err: String(err) });
  }

  if (apps.length === 0) return "Connected apps: none.";
  return `Connected apps: ${apps.join(", ")}.`;
}

async function persistMessage(
  userId: string,
  role: "user" | "assistant",
  content: string,
  conversationId?: string,
): Promise<void> {
  if (!content) return;
  try {
    await query(
      `INSERT INTO personal_chat_messages (user_id, role, content, conversation_id) VALUES ($1, $2, $3, $4)`,
      [userId, role, content, conversationId ?? null],
    );
    if (conversationId) {
      await query(`UPDATE personal_conversations SET updated_at = now() WHERE id = $1`, [conversationId]).catch(
        () => {},
      );
    }
  } catch (err) {
    logger.warn("[personal-assistant] failed to persist chat message", { err: String(err) });
  }
}

// ─── Conversations (chat-history sessions) ─────────────────────────────────────

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: Date;
}

function titleFromMessage(message: string): string {
  const clean = message.trim().replace(/\s+/g, " ");
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean || "New chat";
}

/**
 * Resolve the conversation to write into. A missing/foreign id starts a fresh
 * conversation titled from the opening message, so the history list stays per-thread.
 */
async function ensureConversation(
  userId: string,
  conversationId: string | undefined,
  firstMessage: string,
): Promise<string> {
  if (conversationId) {
    const owned = await query<{ id: string }>(
      `SELECT id FROM personal_conversations WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [conversationId, userId],
    );
    if (owned.rows[0]) return owned.rows[0].id;
  }
  const created = await query<{ id: string }>(
    `INSERT INTO personal_conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
    [userId, titleFromMessage(firstMessage)],
  );
  return created.rows[0].id;
}

export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  try {
    const res = await query<{ id: string; title: string; updated_at: Date }>(
      `SELECT id, title, updated_at FROM personal_conversations
        WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
      [userId],
    );
    return res.rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
  } catch (err) {
    logger.warn("[personal-assistant] listConversations failed", { err: String(err) });
    return [];
  }
}

export async function getConversationMessages(
  userId: string,
  conversationId: string,
): Promise<PersonalChatTurn[]> {
  try {
    const res = await query<{ role: "user" | "assistant"; content: string }>(
      `SELECT m.role, m.content
         FROM personal_chat_messages m
         JOIN personal_conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1 AND c.user_id = $2
        ORDER BY m.created_at ASC`,
      [conversationId, userId],
    );
    return res.rows.map((r) => ({ role: r.role, content: r.content }));
  } catch (err) {
    logger.warn("[personal-assistant] getConversationMessages failed", { err: String(err) });
    return [];
  }
}

async function getConversationTurns(userId: string, conversationId: string, limit = 8): Promise<PersonalChatTurn[]> {
  try {
    const res = await query<{ role: "user" | "assistant"; content: string }>(
      `SELECT role, content FROM personal_chat_messages
        WHERE user_id = $1 AND conversation_id = $2
        ORDER BY created_at DESC LIMIT $3`,
      [userId, conversationId, limit],
    );
    return res.rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  } catch {
    return [];
  }
}

// ─── Action execution (function dispatch) ──────────────────────────────────────

export interface ExecuteContext {
  /** Caller's current coordinates, used by location-aware actions (weather). */
  lat?: number;
  lon?: number;
  /** A file the user attached this turn — used by upload_to_drive (base64, no data: prefix). */
  attachment?: { base64: string; mimeType: string; name: string };
  /** Caller's IANA timezone — anchors scheduled events to their real local time. */
  tz?: string;
}

export interface ExecuteResult {
  ok: boolean;
  message: string;
  data?: unknown;
  /** Deep-link targets the app can open after this action ran. */
  links?: OpenLink[];
}

/**
 * Turn a tool's result into openable deep-links so the app can redirect the user to
 * the right place (the Meet room, the YouTube video, the created doc) instead of
 * leaving a dead URL in the chat. Never throws; unknown tools return [].
 */
export function deriveOpenLinks(
  name: string,
  _args: Record<string, unknown>,
  data: unknown,
): OpenLink[] {
  const d = (data ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  const ytList = (app: "youtube" | "youtube-music"): OpenLink[] => {
    if (!Array.isArray(data)) return [];
    return data
      .slice(0, 3)
      .map((v) => {
        const item = (v ?? {}) as Record<string, unknown>;
        return { label: str(item.title) || "Open video", url: str(item.url), app };
      })
      .filter((l) => l.url);
  };

  switch (name) {
    case "schedule_meet": {
      const links: OpenLink[] = [];
      if (str(d.meetLink)) links.push({ label: "Join Google Meet", url: str(d.meetLink), app: "google-meet" });
      if (str(d.htmlLink)) links.push({ label: "Open in Calendar", url: str(d.htmlLink), app: "google-calendar" });
      return links;
    }
    case "create_drive_doc":
    case "upload_to_drive":
      return str(d.webViewLink) ? [{ label: "Open in Drive", url: str(d.webViewLink), app: "google-drive" }] : [];
    case "share_drive_file": {
      // data is now an array of { name, webViewLink } (one or many shared files).
      if (Array.isArray(data)) {
        return data
          .slice(0, 4)
          .map((v) => {
            const item = (v ?? {}) as Record<string, unknown>;
            return { label: `Open ${str(item.name) || "file"}`, url: str(item.webViewLink), app: "google-drive" as const };
          })
          .filter((l) => l.url);
      }
      return str(d.webViewLink) ? [{ label: "Open in Drive", url: str(d.webViewLink), app: "google-drive" }] : [];
    }
    case "list_drive_files": {
      if (!Array.isArray(data)) return [];
      return data
        .slice(0, 3)
        .map((v) => {
          const item = (v ?? {}) as Record<string, unknown>;
          return { label: str(item.name) || "Open file", url: str(item.webViewLink), app: "google-drive" as const };
        })
        .filter((l) => l.url);
    }
    case "create_youtube_playlist":
      return str(d.url) ? [{ label: "Open playlist", url: str(d.url), app: "youtube" }] : [];
    case "share_onedrive_file": {
      const link = str((d as { link?: unknown }).link);
      return link ? [{ label: "Open shared file", url: link, app: "onedrive" }] : [];
    }
    case "search_youtube":
      return ytList("youtube");
    case "search_youtube_music":
      return ytList("youtube-music");
    case "search_and_play_spotify":
    case "play_spotify": {
      const uri = str(d.uri);
      const m = uri.match(/^spotify:(\w+):(.+)$/);
      const url = m ? `https://open.spotify.com/${m[1]}/${m[2]}` : "";
      return url ? [{ label: `Open in Spotify`, url, app: "spotify" }] : [];
    }
    case "create_github_issue": {
      const url = str((d as { htmlUrl?: unknown; url?: unknown }).htmlUrl) || str((d as { url?: unknown }).url);
      return url ? [{ label: "Open issue", url, app: "web" }] : [];
    }
    default:
      return [];
  }
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

  return { ok: true, message: `Playing "${match.name || q}" on Spotify.`, data: { uri: match.uri, name: match.name } };
}

function splitRepo(full: unknown): { owner: string; repo: string } | null {
  const [owner, repo] = String(full ?? "").trim().split("/");
  return owner && repo ? { owner, repo } : null;
}

function linesOrNone<T>(items: T[], mapper: (item: T) => string, none: string, limit = 8): string {
  if (items.length === 0) return none;
  return items.slice(0, limit).map(mapper).join("\n");
}

/** Find the primary task list + an open task whose title contains the given text. */
async function resolveGoogleTask(
  userId: string,
  title: string,
): Promise<{ listId: string; taskId: string; title: string } | null> {
  const q = title.trim().toLowerCase();
  if (!q) return null;
  const lists = await getTaskLists(userId);
  for (const list of lists) {
    const tasks = await getTasksInList(userId, list.id);
    const match = tasks.find((t) => t.title.toLowerCase().includes(q));
    if (match) return { listId: list.id, taskId: match.id, title: match.title };
  }
  return null;
}

/** Resolve a Drive file id from an explicit id or a (partial) file name. */
async function resolveDriveFileId(
  userId: string,
  args: Record<string, unknown>,
): Promise<{ id: string; name: string } | null> {
  const fileId = String(args.fileId ?? "").trim();
  if (fileId) return { id: fileId, name: String(args.name ?? "file") };
  const name = String(args.name ?? "").trim();
  if (!name) return null;
  const file = await findDriveFile(userId, name);
  return file ? { id: file.id, name: file.name } : null;
}

/**
 * Resolve one OR MANY Drive files from `fileId`/`name` (single), `names` (list), or
 * `query` (all matches). Dedupes by id — this is what lets "delete every invoice" or
 * "share these three files" act on more than one file in a single request.
 */
async function resolveDriveTargets(
  userId: string,
  args: Record<string, unknown>,
): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  const add = (t: { id: string; name: string } | null) => {
    if (t && t.id && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  };

  const single = await resolveDriveFileId(userId, args);
  if (single) add(single);

  const names = Array.isArray(args.names) ? args.names.map(String) : [];
  for (const n of names) {
    const f = await findDriveFile(userId, n);
    add(f ? { id: f.id, name: f.name } : null);
  }

  const q = String(args.query ?? "").trim();
  if (q) {
    const files = await listDriveFiles(userId, q);
    for (const f of files) add({ id: f.id, name: f.name });
  }

  return out;
}

/** Accept a recipient list as an array, comma/semicolon string, or single value. */
function toEmailList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
  return raw
    .flatMap((v) => v.split(/[,;]+/))
    .map((v) => v.trim())
    .filter(Boolean);
}

/** The user's primary connected Gmail address (the From: for sends). */
async function getPrimaryGoogleEmail(userId: string): Promise<string> {
  try {
    const res = await query<{ email: string }>(
      `SELECT email FROM google_accounts WHERE user_id = $1 AND email IS NOT NULL
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
      [userId],
    );
    return res.rows[0]?.email ?? "";
  } catch {
    return "";
  }
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
      case "list_drive_files": {
        const files = await listDriveFiles(userId, args.query ? String(args.query) : undefined);
        const message = linesOrNone(files, (f) => `- ${f.name}${f.webViewLink ? ` (${f.webViewLink})` : ""} [${f.id}]`, "No matching Google Drive files found.", 12);
        return { ok: true, message, data: files };
      }
      case "create_drive_doc": {
        const doc = await createDriveDoc(userId, String(args.name ?? "Untitled document"));
        return { ok: true, message: `Created Google Doc "${doc.name}"${doc.webViewLink ? `: ${doc.webViewLink}` : "."}`, data: doc };
      }
      case "delete_drive_file": {
        const targets = await resolveDriveTargets(userId, args);
        if (targets.length === 0) return { ok: false, message: "Tell me which Drive file(s) to delete (by name), or find them first." };
        for (const t of targets) await deleteDriveFile(userId, t.id);
        const names = targets.map((t) => `"${t.name}"`).join(", ");
        return {
          ok: true,
          message:
            targets.length === 1
              ? `Moved ${names} to the Drive trash.`
              : `Moved ${targets.length} files to the Drive trash: ${names}.`,
        };
      }
      case "share_drive_file": {
        const targets = await resolveDriveTargets(userId, args);
        if (targets.length === 0) return { ok: false, message: "Tell me which Drive file(s) to share (by name), or find them first." };
        const shared: { name: string; webViewLink: string }[] = [];
        for (const t of targets) {
          const link = await shareDriveFile(userId, t.id);
          shared.push({ name: t.name, webViewLink: link });
        }
        const lines = shared.map((s) => `- ${s.name}: ${s.webViewLink}`).join("\n");
        return {
          ok: true,
          message:
            shared.length === 1
              ? `Anyone with this link can now view "${shared[0].name}": ${shared[0].webViewLink}`
              : `Shared ${shared.length} files (anyone with the link can view):\n${lines}`,
          data: shared,
        };
      }
      case "upload_to_drive": {
        if (!ctx.attachment?.base64) {
          return { ok: false, message: "Attach a file first, then ask me to upload it to Drive." };
        }
        const name = String(args.name ?? "").trim() || ctx.attachment.name || "Upload";
        const uploaded = await uploadDriveFile(userId, {
          name,
          mimeType: ctx.attachment.mimeType,
          base64: ctx.attachment.base64,
        });
        return {
          ok: true,
          message: `Uploaded "${uploaded.name}" to Google Drive${uploaded.webViewLink ? `: ${uploaded.webViewLink}` : "."}`,
          data: uploaded,
        };
      }
      case "schedule_meet": {
        const attendees = toEmailList(args.attendees);
        const meeting = await scheduleMeetMeeting(userId, {
          title: String(args.title ?? "Meeting"),
          startTime: String(args.startTime ?? ""),
          endTime: String(args.endTime ?? ""),
          timeZone: args.timeZone ? String(args.timeZone) : ctx.tz,
          attendees,
          description: args.description ? String(args.description) : undefined,
        });
        return {
          ok: true,
          message: `Scheduled "${meeting.summary}"${meeting.meetLink ? ` with Meet link ${meeting.meetLink}` : ""}${attendees?.length ? ` and invited ${attendees.length} attendee(s)` : ""}.`,
          data: meeting,
        };
      }
      case "search_youtube": {
        const videos = await searchYouTube(userId, String(args.query ?? ""));
        const message = linesOrNone(videos, (v) => `- ${v.title}${v.channel ? ` — ${v.channel}` : ""} (${v.url})`, "No YouTube results found.", 10);
        return { ok: true, message, data: videos };
      }
      case "search_youtube_music": {
        const videos = await searchYouTube(userId, String(args.query ?? ""), { musicOnly: true });
        if (videos.length === 0) return { ok: true, message: "No YouTube Music results found.", data: [] };
        const top = videos[0];
        const rest = linesOrNone(videos.slice(1), (v) => `- ${v.title} (${v.url})`, "", 6);
        return {
          ok: true,
          message: `Top result: ${top.title}${top.channel ? ` — ${top.channel}` : ""}\nOpen to play: ${top.url}${rest ? `\n\nMore:\n${rest}` : ""}`,
          data: videos,
        };
      }
      case "list_youtube_playlists": {
        const playlists = await listYouTubePlaylists(userId);
        const message = linesOrNone(playlists, (p) => `- ${p.title} (${p.itemCount} videos) [${p.id}]`, "No YouTube playlists found.", 15);
        return { ok: true, message, data: playlists };
      }
      case "get_youtube_liked": {
        const videos = await getLikedVideos(userId);
        const message = linesOrNone(videos, (v) => `- ${v.title} (${v.url})`, "No liked videos found.", 12);
        return { ok: true, message, data: videos };
      }
      case "create_youtube_playlist": {
        const pl = await createYouTubePlaylist(userId, String(args.title ?? "New playlist"), args.description ? String(args.description) : undefined);
        return { ok: true, message: `Created YouTube playlist "${pl.title}": ${pl.url}`, data: pl };
      }
      case "add_to_youtube_playlist": {
        const playlistId = String(args.playlistId ?? "").trim();
        const videoId = String(args.videoId ?? "").trim();
        if (!playlistId || !videoId) return { ok: false, message: "playlistId and videoId are required." };
        await addToYouTubePlaylist(userId, playlistId, videoId);
        return { ok: true, message: "Added the video to your playlist." };
      }
      case "get_outlook_inbox": {
        const messages = await listOutlookMessages(userId, args.limit ? Number(args.limit) : 10);
        const message = linesOrNone(messages, (m) => `- ${m.subject} — ${m.from}`, "No Outlook messages found.", 10);
        return { ok: true, message, data: messages };
      }
      case "send_outlook_mail": {
        const recipients = toEmailList(args.to);
        if (recipients.length === 0) return { ok: false, message: "Recipient email is required." };
        await sendOutlookMail(userId, { to: recipients.join(", "), subject: String(args.subject ?? ""), body: String(args.body ?? "") });
        return { ok: true, message: `Sent an Outlook email to ${recipients.join(", ")}.` };
      }
      case "send_gmail": {
        const recipients = toEmailList(args.to);
        if (recipients.length === 0) return { ok: false, message: "Who should I send this to? Give me an email or a name to look up." };
        const subject = String(args.subject ?? "").trim();
        const body = String(args.body ?? "").trim();
        if (!subject || !body) return { ok: false, message: "I need a subject and a message body to send the email." };
        const fromEmail = await getPrimaryGoogleEmail(userId);
        if (!fromEmail) return { ok: false, message: "I couldn't resolve your Gmail address. Reconnect Google in Connected Accounts." };
        await sendAutomatedGmailMessage({ userId, fromEmail, toEmail: recipients.join(", "), subject, body });
        return { ok: true, message: `Sent your email to ${recipients.join(", ")}.` };
      }
      case "search_contacts": {
        const contacts = await searchContacts(userId, String(args.query ?? ""));
        const message = linesOrNone(contacts, (c) => `- ${c.name} <${c.email}>`, "No matching contacts found.", 10);
        return { ok: true, message, data: contacts };
      }
      case "list_contacts": {
        const contacts = await listContacts(userId);
        const message = linesOrNone(contacts, (c) => `- ${c.name} <${c.email}>`, "No saved contacts found.", 15);
        return { ok: true, message, data: contacts };
      }
      case "list_outlook_events": {
        const events = await listOutlookEvents(userId, args.limit ? Number(args.limit) : 10);
        const message = linesOrNone(events, (e) => `- ${e.subject}${e.start ? ` — ${e.start}` : ""}`, "No Outlook events found.", 10);
        return { ok: true, message, data: events };
      }
      case "create_outlook_event": {
        const attendees = toEmailList(args.attendees);
        const ev = await createOutlookEvent(userId, {
          subject: String(args.subject ?? "Meeting"),
          startTime: String(args.startTime ?? ""),
          endTime: String(args.endTime ?? ""),
          attendees,
          body: args.body ? String(args.body) : undefined,
        });
        return { ok: true, message: `Created Outlook event "${ev.subject}"${attendees?.length ? ` and invited ${attendees.length} attendee(s)` : ""}.`, data: ev };
      }
      case "list_teams_chats": {
        const chats = await listTeamsChats(userId);
        const message = linesOrNone(chats, (c) => `- ${c.topic} (${c.id})`, "No Teams chats found.", 15);
        return { ok: true, message, data: chats };
      }
      case "send_teams_message": {
        const chatId = String(args.chatId ?? "").trim();
        const text = String(args.text ?? "").trim();
        if (!chatId || !text) return { ok: false, message: "Teams chatId and text are required." };
        await sendTeamsMessage(userId, chatId, text);
        return { ok: true, message: "Posted the message to Teams." };
      }
      case "list_onedrive_files": {
        const files = await listOneDriveFiles(userId, args.query ? String(args.query) : undefined);
        const message = linesOrNone(files, (f) => `- ${f.name}${f.webUrl ? ` (${f.webUrl})` : ""}`, "No OneDrive files found.", 12);
        return { ok: true, message, data: files };
      }
      case "share_onedrive_file": {
        const fileId = String(args.fileId ?? "").trim();
        if (!fileId) return { ok: false, message: "OneDrive fileId is required." };
        const link = await shareOneDriveFile(userId, fileId);
        return { ok: true, message: link ? `Share link: ${link}` : "Created a share link.", data: { link } };
      }
      case "send_whatsapp_message": {
        const to = String(args.to ?? "").trim();
        const body = String(args.body ?? "").trim();
        if (!to || !body) return { ok: false, message: "A recipient number and message text are required." };
        await sendWhatsAppMessage(to, body);
        return { ok: true, message: `Sent a WhatsApp message to ${to}.` };
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
      case "complete_google_task": {
        const found = await resolveGoogleTask(userId, String(args.title ?? ""));
        if (!found) return { ok: false, message: `I couldn't find an open task matching "${args.title ?? ""}".` };
        await completeGoogleTask(userId, found.listId, found.taskId);
        return { ok: true, message: `Marked "${found.title}" as done. ✅` };
      }
      case "delete_google_task": {
        const found = await resolveGoogleTask(userId, String(args.title ?? ""));
        if (!found) return { ok: false, message: `I couldn't find a task matching "${args.title ?? ""}".` };
        await deleteGoogleTask(userId, found.listId, found.taskId);
        return { ok: true, message: `Deleted the task "${found.title}".` };
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
        const channelLines = linesOrNone(
          channels,
          (c) => `- #${c.name} (${c.id})${c.isMember ? "" : " - app not joined"}`,
          "No Slack channels are available.",
          12,
        );
        const message = channels.length > 0 ? `Slack channels I can access:\n${channelLines}` : channelLines;
        return { ok: true, message, data: channels };
      }
      case "post_slack_message": {
        const channel = String(args.channel ?? "").trim();
        const text = String(args.text ?? "").trim();
        if (!channel || !text) return { ok: false, message: "Slack channel and text are required." };
        await postSlackMessage(userId, channel, text);
        return { ok: true, message: "Posted the message to Slack." };
      }
      case "list_slack_users": {
        const users = await getSlackUsers(userId);
        const people = users.filter((u) => !u.isBot);
        const message = linesOrNone(people, (u) => `- ${u.realName || u.name} (@${u.name})`, "No Slack members found.", 15);
        return { ok: true, message, data: people };
      }
      case "send_slack_dm": {
        const person = String(args.user ?? "").trim();
        const text = String(args.text ?? "").trim();
        if (!person || !text) return { ok: false, message: "Tell me who to DM and what to say." };
        const sent = await sendSlackDirectMessage(userId, person, text);
        return { ok: true, message: `Sent a direct message to ${sent.to} on Slack.` };
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
        const result = await listGmailMailboxMessages({
          userId,
          mailbox: "inbox",
          maxResults: args.limit ? Number(args.limit) : 10,
          query: args.query ? String(args.query) : undefined,
        });
        const messages = result.messages;
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
    case "complete_google_task": return `Mark task "${args.title ?? ""}" as done`;
    case "delete_google_task": return `Delete task "${args.title ?? ""}"`;
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
    case "list_drive_files": return `Search Google Drive${args.query ? ` for "${args.query}"` : ""}`;
    case "create_drive_doc": return `Create Google Doc "${args.name ?? ""}"`;
    case "delete_drive_file": return `Delete Drive file ${args.name ? `"${args.name}"` : ""}`.trim();
    case "share_drive_file": return `Share Drive file ${args.name ? `"${args.name}"` : ""}`.trim();
    case "upload_to_drive": return `Upload ${args.name ? `"${args.name}"` : "the attached file"} to Google Drive`;
    case "schedule_meet": return `Schedule a Google Meet "${args.title ?? ""}"`;
    case "search_youtube": return `Search YouTube for "${args.query ?? ""}"`;
    case "search_youtube_music": return `Search YouTube Music for "${args.query ?? ""}"`;
    case "list_youtube_playlists": return "List YouTube playlists";
    case "get_youtube_liked": return "List liked YouTube videos";
    case "create_youtube_playlist": return `Create YouTube playlist "${args.title ?? ""}"`;
    case "add_to_youtube_playlist": return "Add a video to a YouTube playlist";
    case "get_outlook_inbox": return "Check Outlook inbox";
    case "send_outlook_mail": return `Send an Outlook email to ${toEmailList(args.to).join(", ") || "a recipient"}`;
    case "send_gmail": return `Email ${toEmailList(args.to).join(", ") || "a recipient"}: "${args.subject ?? ""}"`;
    case "search_contacts": return `Look up contact "${args.query ?? ""}"`;
    case "list_contacts": return "List contacts";
    case "list_slack_users": return "List Slack members";
    case "send_slack_dm": return `DM ${args.user ?? "someone"} on Slack`;
    case "list_outlook_events": return "List Outlook calendar events";
    case "create_outlook_event": return `Create Outlook event "${args.subject ?? ""}"`;
    case "list_teams_chats": return "List Teams chats";
    case "send_teams_message": return "Post a message to Teams";
    case "list_onedrive_files": return `Search OneDrive${args.query ? ` for "${args.query}"` : ""}`;
    case "share_onedrive_file": return "Create a OneDrive share link";
    case "send_whatsapp_message": return `Send a WhatsApp message to ${args.to ?? "a number"}`;
    case "search_gmail_messages": return `Search Gmail for "${args.query ?? ""}"`;
    case "get_gmail_inbox": return "Check Gmail inbox";
    default: return `Run ${name}`;
  }
}

export const READ_ONLY_ACTIONS = new Set([
  "get_weather",
  "get_fitness_summary",
  "list_drive_files",
  "search_youtube",
  "search_youtube_music",
  "list_youtube_playlists",
  "get_youtube_liked",
  "get_outlook_inbox",
  "list_outlook_events",
  "list_teams_chats",
  "list_onedrive_files",
  "get_gmail_inbox",
  "search_gmail_messages",
  "get_calendar_events",
  "list_google_tasks",
  "list_todoist_tasks",
  "search_notion_pages",
  "read_notion_page",
  "list_slack_channels",
  "list_slack_users",
  "search_contacts",
  "list_contacts",
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
  /** A non-image file the user attached (held for upload_to_drive; name told to the model). */
  attachment?: { base64: string; mimeType: string; name: string };
  /** Caller's coordinates for location-aware tools (weather). */
  lat?: number;
  lon?: number;
  /** Client's current ISO timestamp + IANA timezone, so relative dates resolve correctly. */
  clientNow?: string;
  tz?: string;
  /** Existing conversation to append to; omitted starts a new one. */
  conversationId?: string;
}

// Verbs and app names that signal the user wants an action, not a chat answer.
// Used to decide whether a prose-only Gemini reply deserves a forced-tool retry.
const ACTION_INTENT_PATTERN =
  /\b(play|pause|skip|resume|next|previous|create|add|make|new|list|show|get|find|search|read|post|send|open|schedule|remind|check|draft|write|log|update|assign|move)\b|\b(spotify|todoist|notion|slack|github|jira|trello|gmail|calendar|weather|fitness|task|song|track|playlist|issue|pull request|pr|card|board|channel|note|page|email)\b/i;

function looksLikeActionRequest(message: string): boolean {
  return ACTION_INTENT_PATTERN.test(message);
}

export async function command(
  userId: string,
  message: string,
  opts: CommandOptions = {},
): Promise<PersonalCommandResult> {
  // Fail fast with a clear, actionable message when the AI isn't configured —
  // instead of a silent generic "trouble connecting". Log loudly: a mis-set key or
  // PROFESSIONAL_AI_PROVIDER=demo makes the assistant look "dumb" when it's just off.
  const convId = await ensureConversation(userId, opts.conversationId, message);

  if (!isGeminiLive()) {
    logger.warn(
      "[personal-assistant] Gemini NOT live — returning fallback. Check GEMINI_API_KEY is set and PROFESSIONAL_AI_PROVIDER is not 'demo'.",
    );
    const answer = "The AI assistant isn't configured yet. Add a GEMINI_API_KEY on the server to enable it.";
    await persistMessage(userId, "user", message, convId);
    await persistMessage(userId, "assistant", answer, convId);
    return { answer, action: null, isLive: false, conversationId: convId };
  }

  const persona = await getPersonalPersona(userId);
  const systemPrompt = buildSystemPrompt(persona);
  const appsSummary = await connectedAppsSummary(userId);

  // Multimodal: an attached image is inlined so Gemini can reason about it (receipts,
  // screenshots…). A non-image attachment is not inlined (could be large / binary) —
  // we just tell the model its name so it can offer to upload it to Drive.
  const nowContext = buildNowContext(opts.clientNow, opts.tz);
  const parts: GeminiPart[] = [{ text: nowContext }, { text: appsSummary }];
  if (opts.attachment) {
    parts.push({ text: `The user attached a file named "${opts.attachment.name}" (${opts.attachment.mimeType}). If they want it saved, use upload_to_drive.` });
  }
  parts.push({ text: message });
  if (opts.image) {
    parts.push({ inlineData: { mimeType: opts.image.mimeType, data: opts.image.data } });
  }

  // Load prior turns of THIS conversation BEFORE persisting the current message so the
  // model gets memory without duplicating the turn we pass separately as userParts.
  const history = await getConversationTurns(userId, convId, 8);
  await persistMessage(userId, "user", message, convId);

  try {
    const outcome = await runAgentTurn({
      system: systemPrompt,
      tools: PERSONAL_TOOLS,
      userParts: parts,
      history,
      isReadOnly: (name) => READ_ONLY_ACTIONS.has(name),
      execReadOnly: (name, args) =>
        executeAction(userId, name, args, { lat: opts.lat, lon: opts.lon, attachment: opts.attachment, tz: opts.tz }),
      looksLikeAction: looksLikeActionRequest(message),
    });

    if (outcome.kind === "action") {
      // Write action — return it for user confirmation before executing.
      const summary = summarizeAction(outcome.name, outcome.args);
      await persistMessage(userId, "assistant", summary, convId);
      return {
        answer: null,
        action: { id: randomUUID(), name: outcome.name, args: outcome.args, summary, needsConfirm: true },
        isLive: true,
        conversationId: convId,
      };
    }

    await persistMessage(userId, "assistant", outcome.text, convId);
    const links = outcome.via ? deriveOpenLinks(outcome.via.name, outcome.via.args, outcome.via.data) : [];
    return {
      answer: outcome.text,
      action: null,
      isLive: true,
      links: links.length ? links : undefined,
      conversationId: convId,
    };
  } catch (err) {
    logger.error("[personal-assistant] command failed", { err: String(err) });
    const answer = "I ran into a problem reaching the AI service. Please try again in a moment.";
    await persistMessage(userId, "assistant", answer, convId);
    return { answer, action: null, isLive: false, conversationId: convId };
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

// ─── Life hub summary ──────────────────────────────────────────────────────────

export interface LifeSummaryEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string | null;
}

export interface LifeSummaryTask {
  title: string;
  due: string | null;
}

export interface LifeSummary {
  generatedAt: string;
  counts: { happeningNow: number; laterToday: number; upcoming: number; pendingTasks: number };
  happeningNow: LifeSummaryEvent[];
  laterToday: LifeSummaryEvent[];
  upcoming: LifeSummaryEvent[];
  recentlyEnded: LifeSummaryEvent[];
  tasksDue: LifeSummaryTask[];
}

/** YYYY-MM-DD for an instant in a given IANA timezone (falls back to the server zone). */
function localDateKey(iso: string, tz?: string): string {
  const d = new Date(iso);
  try {
    return d.toLocaleDateString("en-CA", tz ? { timeZone: tz } : undefined);
  } catch {
    return d.toLocaleDateString("en-CA");
  }
}

/**
 * A calendar/task snapshot for the "life hub" — what just happened, what's happening
 * now, and what's coming up. Mode-scoped via `googleAccountId` (Personal vs Work).
 * Pure aggregation of real calendar + task data; never invents anything.
 */
export async function getLifeSummary(
  userId: string,
  opts: { now?: string; tz?: string; googleAccountId?: string | null } = {},
): Promise<LifeSummary> {
  const nowIso = opts.now && !Number.isNaN(Date.parse(opts.now)) ? opts.now : new Date().toISOString();
  const now = new Date(nowIso);
  const from = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const to = new Date(now.getTime() + 7 * 86_400_000).toISOString();

  const toSummaryEvent = (e: {
    id?: string;
    title: string;
    startTime: Date;
    endTime: Date;
    location: string | null;
  }): LifeSummaryEvent => ({
    id: e.id ?? "",
    title: e.title,
    start: e.startTime.toISOString(),
    end: e.endTime.toISOString(),
    location: e.location,
  });

  let events: LifeSummaryEvent[] = [];
  try {
    const rows = await getUserEvents(userId, from, to, opts.googleAccountId);
    events = rows.map(toSummaryEvent).sort((a, b) => a.start.localeCompare(b.start));
  } catch (err) {
    logger.warn("[personal-assistant] getLifeSummary events failed", { err: String(err) });
  }

  const todayKey = localDateKey(nowIso, opts.tz);
  const happeningNow: LifeSummaryEvent[] = [];
  const laterToday: LifeSummaryEvent[] = [];
  const upcoming: LifeSummaryEvent[] = [];
  const recentlyEnded: LifeSummaryEvent[] = [];

  for (const e of events) {
    const start = new Date(e.start).getTime();
    const end = new Date(e.end).getTime();
    const t = now.getTime();
    if (start <= t && end >= t) happeningNow.push(e);
    else if (end < t) recentlyEnded.push(e);
    else if (localDateKey(e.start, opts.tz) === todayKey) laterToday.push(e);
    else upcoming.push(e);
  }

  let tasksDue: LifeSummaryTask[] = [];
  try {
    const lists = await getTaskLists(userId);
    const listId = lists[0]?.id;
    if (listId) {
      const tasks = await getTasksInList(userId, listId);
      tasksDue = tasks
        .filter((t) => t.status !== "completed")
        .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
        .slice(0, 6)
        .map((t) => ({ title: t.title, due: t.due }));
    }
  } catch (err) {
    logger.warn("[personal-assistant] getLifeSummary tasks failed", { err: String(err) });
  }

  return {
    generatedAt: nowIso,
    counts: {
      happeningNow: happeningNow.length,
      laterToday: laterToday.length,
      upcoming: upcoming.length,
      pendingTasks: tasksDue.length,
    },
    happeningNow,
    laterToday,
    upcoming: upcoming.slice(0, 6),
    recentlyEnded: recentlyEnded.slice(-4).reverse(),
    tasksDue,
  };
}

export async function clearChatHistory(userId: string): Promise<void> {
  try {
    await query(`DELETE FROM personal_chat_messages WHERE user_id = $1`, [userId]);
  } catch (err) {
    logger.warn("[personal-assistant] clearChatHistory failed", { err: String(err) });
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
