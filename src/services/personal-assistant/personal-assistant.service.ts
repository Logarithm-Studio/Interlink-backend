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
// Spotify is no longer a native integration — it's brokered through Composio
// (SPOTIFY_* tools), so the native spotify.service and its tools were removed here.
import { getCurrentWeather } from "../weather/weather.service";
import { getDailySummary } from "../fitness/fitness.service";
import {
  listDriveFiles,
  createDriveDoc,
  deleteDriveFile,
  shareDriveFile,
  findDriveFile,
  uploadDriveFile,
  exportDriveFileToPdf,
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
import { listSpreadsheets, readSheetRange } from "../hr/sheets.service";
import { searchContacts, listContacts } from "../google/contacts.service";
import {
  searchPages as searchNotionPages,
  getPageContent,
  createPage as createNotionPage,
  getDatabases as getNotionDatabases,
  appendToPage as appendToNotionPage,
  createDatabaseRow as createNotionDatabaseRow,
} from "../notion/notion.service";
import {
  getChannels as getSlackChannels,
  postMessage as postSlackMessage,
  getUsers as getSlackUsers,
  sendDirectMessage as sendSlackDirectMessage,
} from "../slack/slack.service";
import {
  getComposioToolsForUser,
  executeComposioTool,
  isComposioToolName,
  isComposioReadOnlyTool,
  summarizeComposioAction,
  connectedToolkitNames,
} from "../composio/composio.service";
import { getRepos as getGitHubRepos, getIssues as getGitHubIssues, getPullRequests as getGitHubPullRequests, createIssue as createGitHubIssue } from "../pm/github.service";
import { getProjects as getJiraProjects, searchIssues as searchJiraIssues, createIssue as createJiraIssue } from "../jira/jira.service";
import { getBoards as getTrelloBoards, getListsForBoard, getCardsForBoard, createCard as createTrelloCard } from "../pm/trello.service";

// ─── Profession-aware system prompts ─────────────────────────────────────────

const PROFESSION_CONTEXT: Record<string, string> = {
  developer: "The user is a software developer. Prioritize GitHub PRs, coding tasks, and technical work. For music suggestions, default to focus/coding playlists. When calendar events involve 'standup', 'review', or 'sprint', treat them as high-priority.",
  designer: "The user is a designer/creative professional. Prioritize creative tasks, portfolio reviews, and client presentations in their calendar.",
  student: "The user is a student. Prioritize assignments and study sessions. Use due dates on tasks as hard deadlines. Weather matters for campus commute. If they connected Canvas via Composio, act on their LMS directly with the CANVAS_* tools — list courses, show upcoming assignments and grades, view a course's people/roster, create assignments, and enroll people. For 'here's a spreadsheet, add these people to <course>', call read_sheet to get the rows, then enroll each person with the Canvas enroll tool.",
  healthcare_professional: "The user works in healthcare. Prioritize patient-related scheduling, fitness metrics, and work-life balance. Be sensitive about sensitive medical context.",
  business_professional: "The user is a business professional. Prioritize meetings, client calls, and action items. Suggest productivity-focused music.",
  freelancer: "The user is a freelancer. Balance client work with personal time. Track deadlines across Todoist and Calendar carefully.",
  creative: "The user is in a creative field. Support inspiration-seeking, idea capture to Notion, and flexible scheduling.",
  educator: "The user is an educator. Prioritize class schedules, grading deadlines, and student communication.",
  general: "Help the user manage their personal life efficiently across calendar, tasks, notes, music, and fitness.",
};

/**
 * Non-negotiable rules shared by EVERY agent (personal + all professional personas).
 *
 * These exist because the agent was refusing things it can actually do ("I lack the
 * ability to send emails"), answering in shallow one-liners, and was unconstrained on
 * link fabrication / sensitive data. Appended to every system prompt.
 */
export const GLOBAL_AGENT_RULES = [
  "NON-NEGOTIABLE RULES:",
  "1. CAPABILITY HONESTY — Never say you 'can't' or 'lack the ability' to do something your tools CAN do.",
  "   You can: send email, read/search mail, analyze attached images and PDFs, schedule meetings with Meet links,",
  "   manage calendar/tasks/files/notes, message people on Slack and WhatsApp, and work across GitHub/Jira/Trello/Notion.",
  "   If an app the task needs is not connected yet, name that ONE app, offer to connect it, and STILL do everything",
  "   you can right now (draft the email, prepare the content, outline the steps). Never answer with a bare refusal.",
  "2. DEPTH — Reason the problem through properly and answer completely. For anything non-trivial, state your plan,",
  "   then act, then say what you did and what's next. Structure longer answers with short headings or bullets.",
  "   Never reply with a vague one-liner, a deflection, or a padded disclaimer. Being unhelpful is a failure.",
  "3. NO HALLUCINATED LINKS — Never invent, guess, or infer a URL, file link, image reference, or citation.",
  "   Only include a link that a tool returned this turn, that appears in the data snapshot, or that the user gave you.",
  "   If you don't have a verified link, say so plainly instead of fabricating one.",
  "4. PRIVACY — Treat health, biometric, financial and personal-contact data as sensitive. Use it to answer the",
  "   question, but never echo raw sensitive values back beyond what the task actually needs.",
  "5. PARTIAL PROGRESS BEATS REFUSAL — If you genuinely cannot complete the whole request, do the part you can and",
  "   clearly state the single blocker and how to clear it.",
  "6. NEVER FABRICATE ATTACHMENT CONTENT — If the user refers to 'this photo'/'this file' but NO attachment was",
  "   provided in this turn, do NOT invent what it contains. Say plainly that nothing is attached and ask them to",
  "   attach it. Only describe an image or document you were actually given. The same goes for any data you were",
  "   not shown: never invent figures, names, contacts, or sources to fill a gap.",
].join("\n");

export const CONNECTED_APP_ORCHESTRATION_PROMPT = [
  "Connected-app workflow rules:",
  "- Treat broad or vague requests as workflow requests. Infer the user's likely goal from the current prompt, conversation history, persona, and connected apps.",
  "- You can chain tools to finish a workflow in one turn. When an ID is missing (channel, board, list, repo, project, page), CALL the relevant discovery tool FIRST — its result is fed back to you in the same turn — then call the action tool with the resolved ID. Never ask the user for an ID you can look up.",
  "- Read/list/search tools run automatically as you chain. Only the final WRITE action (create/send/post/play) is shown to the user to confirm before it executes — so keep chaining until you reach that write, then emit it.",
  "- Pick the most appropriate connected app automatically: code work maps to GitHub/Jira/Slack, planning notes to Notion/Trello/Jira, tasks to Google Tasks/Todoist/Trello/Jira, team updates to Slack, music to YouTube Music (or Spotify if the user connected it via Composio), email questions to Gmail.",
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

Apps you act on: Google Calendar, Gmail, Google Tasks, Google Drive, Google Meet, Google Fit, YouTube,
YouTube Music, Outlook (mail + calendar), Microsoft Teams, OneDrive, WhatsApp (send only), Todoist,
Notion, Slack, GitHub, Jira, Trello, and weather. The "Connected apps" line each turn tells you which are
already authorized. If a task needs one that ISN'T connected, name it, offer to connect it, and still do
everything you can right now — do NOT refuse the whole request.
The user can also connect apps through Composio (Spotify, Zoom, Calendly, Dropbox, Airtable, Telegram,
Discord, HubSpot, Stripe, Linear, and more). Those tools appear as UPPER_SNAKE names prefixed with the app
(e.g. SPOTIFY_PAUSE_PLAYBACK, CALENDLY_LIST_EVENTS) and are only usable when the app is named on the
"Connected apps" line — if it isn't there, tell the user to connect it in Settings → Connected accounts.
For music requests, prefer YouTube Music (search_youtube_music) — it returns a link to open. If the user
connected Spotify via Composio, you can also control their playback with the SPOTIFY_* tools.

How to think each turn:
1. Infer the real goal. Use the conversation history to resolve references like "it", "the other one", "that deal", "there".
2. Choose the app(s) and tool(s) that achieve it. For multi-step goals, chain discovery → action within the same turn.
3. Gather missing IDs with discovery tools BEFORE acting — never ask for an ID you can look up, and never invent one.
4. Act. Read/list/search tools answer immediately; write actions (create/send/post/play) are confirmed by the app.
5. Then explain what you did (and what you'd do next) so the user is never left guessing.

If a request is analytical rather than an app action (research, drafting, explaining, summarizing, building a
document or a plan), just DO the work directly and thoroughly with your own reasoning — that is squarely in
scope. Where you lack live data, be explicit about what is estimated vs. verified, and never invent figures,
sources, or links.

${CONNECTED_APP_ORCHESTRATION_PROMPT}

${GLOBAL_AGENT_RULES}

Signature "life agent" behaviors — handle these proactively and thoroughly:
- "Prepare/plan my day" → read the calendar and tasks (plus weather/fitness if relevant), then give a prioritized, time-blocked plan and offer to reschedule conflicts.
- "Who should I follow up with?" → scan recent Gmail and calendar for stale or unanswered threads and suggest follow-ups (offer to draft them).
- Meeting / travel prep → check the next event and its timing, and flag if the user should leave soon.
- Life admin → surface tasks due, reminders, and anything time-sensitive, and offer to act on them.

Mapping examples (natural phrasing → tool):
- "play see you again" → search_youtube_music(query="see you again"); if Spotify is connected via Composio, use SPOTIFY_* tools to actually start playback.
- "add milk to my todoist" → create_todoist_task(content="milk")
- "post to the team that the build is green" → list_slack_channels → post_slack_message(channel=<resolved id>, text=…)
- "what's on my calendar tomorrow" → get_calendar_events(days=1)
- "create a card 'ship v2' on my roadmap board" → list_trello_boards → list_trello_lists → create_trello_card(…)

Tone: warm, sharp, and genuinely competent — like an excellent human chief of staff. Substance over brevity:
be as thorough as the question deserves (a quick fact gets a quick answer; a real task gets a real, structured
one). Never robotic, never childish, never padded with disclaimers, and never a one-line brush-off.`;
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
    description:
      "Create a Google Doc — a report, memo, brief, meeting notes, proposal, summary, letter, etc. — in the user's Drive with FULL formatted content. Use this whenever the user asks you to write up, draft, produce, or SEND a document/report/file. Put the ENTIRE document body in `content` as Markdown (use #/##/### headings, - bullet lists, 1. numbered lists, **bold**); never leave it empty. The result is a real Google Doc the user can open, download as PDF or Word, or share. IMPORTANT: to SEND the finished document to someone (\"create X and send it to <email>\"), set `emailTo` to their email — this one tool creates the doc, makes it viewable, and emails them the link in a single step. Do NOT create the doc and then separately call send_gmail; use emailTo instead. Set `share: true` (without emailTo) to just make it link-shareable.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Document title." },
        content: {
          type: "string",
          description: "The complete document body in Markdown. Write the full report/letter/notes here.",
        },
        share: {
          type: "boolean",
          description: "If true, make the doc link-shareable (anyone with the link can view) and return that link.",
        },
        emailTo: {
          type: "string",
          description: "Recipient email address(es), comma-separated. When set, the doc is created, shared, and emailed to them with the link — all in one step.",
        },
        emailSubject: { type: "string", description: "Optional subject for the email (defaults to the document title)." },
        emailBody: { type: "string", description: "Optional message to include above the document link in the email." },
      },
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
    name: "list_spreadsheets",
    description:
      "List the user's Google Sheets (id + name). Use this to resolve a spreadsheet the user named (e.g. 'the new employees sheet') to its id before reading it or emailing from it.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_sheet",
    description:
      "Read rows from a Google Sheet. Pass spreadsheetId (resolve it with list_spreadsheets first) and an optional A1 range (defaults to the first sheet). Returns the header row + data rows so you can inspect columns like name, email, and join date.",
    parameters: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet id (from list_spreadsheets)." },
        range: { type: "string", description: "Optional A1 range, e.g. 'Sheet1!A1:Z1000'. Defaults to the first sheet." },
      },
      required: ["spreadsheetId"],
    },
  },
  {
    name: "send_bulk_email_from_sheet",
    description:
      "Send a personalized templated email to many people listed in a Google Sheet — e.g. a welcome message to new employees who joined within a date range. Reads the sheet, keeps rows whose date column falls between fromDate and toDate (when given), fills {{ColumnName}} placeholders (plus {{name}} and {{email}}) per row, and sends each via Gmail. Resolve the sheet with list_spreadsheets first, or pass spreadsheetName and it will be resolved. This is a WRITE/bulk action — the app confirms before anything is sent.",
    parameters: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Spreadsheet id (resolve via list_spreadsheets)." },
        spreadsheetName: { type: "string", description: "Spreadsheet name — used if spreadsheetId is not provided." },
        range: { type: "string", description: "Optional A1 range; defaults to the first sheet." },
        emailColumn: { type: "string", description: "Header of the email column (auto-detected if omitted)." },
        nameColumn: { type: "string", description: "Header of the recipient's name column (auto-detected if omitted)." },
        dateColumn: { type: "string", description: "Header of the join/entry date column used for the date filter (auto-detected if omitted)." },
        fromDate: { type: "string", description: "Only include rows dated on/after this YYYY-MM-DD (optional)." },
        toDate: { type: "string", description: "Only include rows dated on/before this YYYY-MM-DD (optional)." },
        subject: { type: "string", description: "Email subject; may include {{ColumnName}} placeholders." },
        bodyTemplate: { type: "string", description: "Email body; use {{name}}, {{email}}, or any {{ColumnName}} placeholder to personalize per row." },
      },
      required: ["subject", "bodyTemplate"],
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
    name: "append_to_notion_page",
    description:
      "Append content (markdown: headings, bullets, to-dos, code) to an EXISTING Notion page. Resolve the page with search_notion_pages first, or pass pageQuery to match by title.",
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "Notion page id (preferred)." },
        pageQuery: { type: "string", description: "Title (or part) of the page to append to, if id unknown." },
        content: { type: "string", description: "Markdown content to append." },
      },
      required: ["content"],
    },
  },
  {
    name: "list_notion_databases",
    description: "List the user's Notion databases (id + title) — e.g. to add a row to a task/CRM database.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "add_notion_database_row",
    description:
      "Add a row (item) to a Notion database — e.g. a task, CRM contact, or tracker entry. Resolve the database id with list_notion_databases first, or pass databaseQuery to match by title.",
    parameters: {
      type: "object",
      properties: {
        databaseId: { type: "string", description: "Notion database id (preferred)." },
        databaseQuery: { type: "string", description: "Title (or part) of the database, if id unknown." },
        title: { type: "string", description: "The row's title/name." },
        content: { type: "string", description: "Optional markdown body for the new row's page." },
      },
      required: ["title"],
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

  // Composio-brokered apps (HubSpot, Stripe, Linear, …). The model only uses a tool if it
  // knows the app is available — omitting these here is exactly the bug that made the
  // Google-backed apps invisible to the agent (fixed 2026-07-05).
  try {
    apps.push(...(await connectedToolkitNames(userId)));
  } catch (err) {
    logger.warn("[personal-assistant] connectedAppsSummary composio failed", { err: String(err) });
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

/** Delete a conversation and its messages (messages cascade). Scoped to the user. */
export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  await query(`DELETE FROM personal_conversations WHERE id = $1 AND user_id = $2`, [conversationId, userId]);
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
    case "create_github_issue": {
      const url = str((d as { htmlUrl?: unknown; url?: unknown }).htmlUrl) || str((d as { url?: unknown }).url);
      return url ? [{ label: "Open issue", url, app: "web" }] : [];
    }
    default:
      return [];
  }
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

// ─── Sheet → templated bulk email (e.g. "welcome new employees in a date range") ───

/** Cap a single bulk-send so a malformed sheet can't fan out into thousands of emails. */
const MAX_BULK_EMAILS = 100;

/** Resolve a sheet column by an explicit header hint (or a column letter), else common fallbacks. */
function resolveColumnIndex(headers: string[], hint: string | undefined, fallbacks: string[]): number {
  const norm = (s: string) => s.toLowerCase().trim();
  const H = headers.map(norm);
  if (hint && hint.trim()) {
    const h = norm(hint);
    const exact = H.indexOf(h);
    if (exact >= 0) return exact;
    const partial = H.findIndex((x) => x.includes(h) || h.includes(x));
    if (partial >= 0) return partial;
    if (/^[A-Za-z]$/.test(hint.trim())) return hint.trim().toUpperCase().charCodeAt(0) - 65;
  }
  for (const f of fallbacks) {
    const i = H.findIndex((x) => x.includes(f));
    if (i >= 0) return i;
  }
  return -1;
}

/** Fill {{placeholder}} tokens from a row record (keys are lower-cased header names + name/email). */
function renderTemplate(tpl: string, record: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key: string) => record[key.toLowerCase().trim()] ?? "");
}

async function sendBulkEmailFromSheet(userId: string, args: Record<string, unknown>): Promise<ExecuteResult> {
  const subject = String(args.subject ?? "").trim();
  const bodyTemplate = String(args.bodyTemplate ?? "").trim();
  if (!subject || !bodyTemplate) {
    return { ok: false, message: "I need a subject and a body template to send from the sheet." };
  }

  // Resolve the sheet by id, or by name via a Drive lookup.
  let spreadsheetId = String(args.spreadsheetId ?? "").trim();
  if (!spreadsheetId && args.spreadsheetName) {
    const name = String(args.spreadsheetName).trim().toLowerCase();
    const all = await listSpreadsheets(userId);
    const match = all.find((s) => s.name.toLowerCase() === name) ?? all.find((s) => s.name.toLowerCase().includes(name));
    if (!match) return { ok: false, message: `I couldn't find a Google Sheet named "${args.spreadsheetName}".` };
    spreadsheetId = match.id;
  }
  if (!spreadsheetId) return { ok: false, message: "Which spreadsheet? Resolve it with list_spreadsheets first, or give me its name." };

  const range = String(args.range ?? "A1:Z1000").trim() || "A1:Z1000";
  const rows = await readSheetRange(userId, spreadsheetId, range);
  if (rows.length < 2) return { ok: false, message: "That sheet has no data rows to email." };

  const headers = rows[0].values;
  const emailIdx = resolveColumnIndex(headers, args.emailColumn ? String(args.emailColumn) : undefined, ["email", "e-mail", "mail"]);
  if (emailIdx < 0) {
    return { ok: false, message: "I couldn't find an email column in that sheet. Tell me which column holds the email addresses." };
  }
  const nameIdx = resolveColumnIndex(headers, args.nameColumn ? String(args.nameColumn) : undefined, ["name", "employee", "full name"]);
  const dateIdx = resolveColumnIndex(headers, args.dateColumn ? String(args.dateColumn) : undefined, ["join", "start", "hired", "date", "created", "timestamp"]);

  const fromDate = args.fromDate ? new Date(`${String(args.fromDate)}T00:00:00`) : null;
  const toDate = args.toDate ? new Date(`${String(args.toDate)}T23:59:59`) : null;
  const inRange = (v: string): boolean => {
    if (!fromDate && !toDate) return true;
    if (dateIdx < 0) return true; // no date column to filter on → include the row
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return false;
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  };

  const fromEmail = await getPrimaryGoogleEmail(userId);
  if (!fromEmail) return { ok: false, message: "I couldn't resolve your Gmail address. Reconnect Google in Connected Accounts." };

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const sent: string[] = [];
  let skipped = 0;

  for (const row of rows.slice(1)) {
    if (sent.length >= MAX_BULK_EMAILS) break;
    const cells = row.values;
    if (!inRange(dateIdx >= 0 ? cells[dateIdx] ?? "" : "")) continue;
    const to = (cells[emailIdx] ?? "").trim();
    if (!emailRe.test(to)) { skipped++; continue; }

    const record: Record<string, string> = {};
    headers.forEach((h, i) => { record[h.toLowerCase().trim()] = (cells[i] ?? "").trim(); });
    record.email = to;
    if (nameIdx >= 0) record.name = (cells[nameIdx] ?? "").trim();

    try {
      await sendAutomatedGmailMessage({
        userId,
        fromEmail,
        toEmail: to,
        subject: renderTemplate(subject, record),
        body: renderTemplate(bodyTemplate, record),
      });
      sent.push(record.name || to);
    } catch {
      skipped++;
    }
  }

  if (sent.length === 0) {
    return { ok: false, message: `No emails were sent — no rows had a valid email in the given range${skipped ? ` (${skipped} skipped)` : ""}.` };
  }
  const rangeNote = fromDate || toDate ? ` (joined ${args.fromDate ?? "any"} → ${args.toDate ?? "any"})` : "";
  return {
    ok: true,
    message: `Sent to ${sent.length} recipient(s)${rangeNote}: ${sent.slice(0, 15).join(", ")}${sent.length > 15 ? "…" : ""}.${skipped ? ` Skipped ${skipped} row(s) without a valid email.` : ""}`,
  };
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
        const doc = await createDriveDoc(
          userId,
          String(args.name ?? "Untitled document"),
          typeof args.content === "string" ? args.content : undefined,
        );
        const emailTo = toEmailList(args.emailTo);
        // A private link is useless to an external recipient, so emailing forces a share.
        const shouldShare = args.share === true || emailTo.length > 0;
        let link = doc.webViewLink;
        let shared = false;
        if (shouldShare && doc.id) {
          try {
            const shareLink = await shareDriveFile(userId, doc.id);
            if (shareLink) link = shareLink;
            shared = true;
          } catch {
            /* sharing failed — fall back to the private link */
          }
        }

        // If asked to send it, email it in the same step (no separate send_gmail) — with the
        // document attached as a PDF, plus the link in the body as a fallback.
        let emailNote = "";
        if (emailTo.length > 0) {
          const fromEmail = await getPrimaryGoogleEmail(userId);
          if (!fromEmail) {
            emailNote = " — but I couldn't send the email (reconnect Google in Connected Accounts)";
          } else {
            const subject = String(args.emailSubject ?? "").trim() || doc.name;
            const preamble = String(args.emailBody ?? "").trim();
            // Export the Doc to a real PDF and attach it. If export fails, still send the link.
            let attachments: { filename: string; mimeType: string; base64: string }[] | undefined;
            if (doc.id) {
              try {
                const pdfBase64 = await exportDriveFileToPdf(userId, doc.id);
                if (pdfBase64) attachments = [{ filename: `${doc.name}.pdf`, mimeType: "application/pdf", base64: pdfBase64 }];
              } catch (err) {
                console.error("[create_drive_doc] PDF export failed:", err instanceof Error ? err.message : err);
              }
            }
            const attachedPhrase = attachments ? ' (PDF attached below).' : ':';
            const body = `${preamble ? `${preamble}\n\n` : `Hi,\n\nPlease find the document "${doc.name}" attached${attachedPhrase}\n\n`}${link}\n\nSent via Interlink.`;
            try {
              await sendAutomatedGmailMessage({ userId, fromEmail, toEmail: emailTo.join(", "), subject, body, attachments });
              emailNote = ` and emailed it to ${emailTo.join(", ")}${attachments ? " with the PDF attached" : ""}`;
            } catch (err) {
              emailNote = ` — the doc was created but the email to ${emailTo.join(", ")} failed (${err instanceof Error ? err.message : "unknown error"})`;
            }
          }
        }

        const shareNote = shared && emailTo.length === 0 ? " Anyone with the link can view it." : "";
        return {
          ok: true,
          message: `Created "${doc.name}"${emailNote}${link ? `: ${link}` : "."}${shareNote}`,
          data: doc,
          links: link ? [{ app: "google-drive", url: link, label: "Open document" }] : undefined,
        };
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
      case "list_spreadsheets": {
        const sheets = await listSpreadsheets(userId);
        const message = linesOrNone(sheets, (s) => `- ${s.name} (id: ${s.id})`, "You have no Google Sheets I can see.", 30);
        return { ok: true, message, data: sheets };
      }
      case "read_sheet": {
        const spreadsheetId = String(args.spreadsheetId ?? "").trim();
        if (!spreadsheetId) return { ok: false, message: "Which spreadsheet? Resolve it with list_spreadsheets first." };
        const range = String(args.range ?? "A1:Z1000").trim() || "A1:Z1000";
        const rows = await readSheetRange(userId, spreadsheetId, range);
        if (rows.length === 0) return { ok: true, message: "That sheet/range is empty.", data: [] };
        const preview = rows.slice(0, 20).map((r) => `- ${r.values.join(" | ")}`).join("\n");
        return { ok: true, message: `${rows.length} row(s):\n${preview}${rows.length > 20 ? "\n…" : ""}`, data: rows };
      }
      case "send_bulk_email_from_sheet":
        return sendBulkEmailFromSheet(userId, args);
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
      case "append_to_notion_page": {
        if (!(await isConnected(userId, "notion"))) {
          return { ok: false, message: "Notion is not connected. Connect it from Settings → Connected Accounts." };
        }
        const content = String(args.content ?? "").trim();
        if (!content) return { ok: false, message: "Tell me what content to append." };
        let pageId = String(args.pageId ?? "").trim();
        if (!pageId) {
          const q = String(args.pageQuery ?? "").trim();
          if (!q) return { ok: false, message: "Which Notion page? Give a page title or search Notion first." };
          const pages = await searchNotionPages(userId, q);
          pageId = pages[0]?.id ?? "";
          if (!pageId) return { ok: false, message: `I couldn't find a Notion page matching "${q}".` };
        }
        await appendToNotionPage(userId, pageId, content);
        return { ok: true, message: "Added that to your Notion page." };
      }
      case "list_notion_databases": {
        const dbs = await getNotionDatabases(userId);
        const message = linesOrNone(dbs, (d) => `- ${d.title} (${d.id})`, "No Notion databases found.");
        return { ok: true, message, data: dbs };
      }
      case "add_notion_database_row": {
        if (!(await isConnected(userId, "notion"))) {
          return { ok: false, message: "Notion is not connected. Connect it from Settings → Connected Accounts." };
        }
        const title = String(args.title ?? "").trim();
        if (!title) return { ok: false, message: "What should the new row be called?" };
        let databaseId = String(args.databaseId ?? "").trim();
        if (!databaseId) {
          const q = String(args.databaseQuery ?? "").trim();
          const dbs = await getNotionDatabases(userId);
          const match = q
            ? dbs.find((d) => d.title.toLowerCase().includes(q.toLowerCase())) ?? dbs[0]
            : dbs[0];
          databaseId = match?.id ?? "";
          if (!databaseId) return { ok: false, message: "I couldn't find a Notion database to add to. List your databases first." };
        }
        const row = await createNotionDatabaseRow(userId, databaseId, title, args.content ? String(args.content) : undefined);
        return { ok: true, message: `Added "${row.title}" to your Notion database.`, data: row };
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
        const message = linesOrNone(people, (u) => `- ${u.profileRealName || u.realName || u.displayName || u.name} (@${u.name})`, "No Slack members found.", 15);
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
        // Not a native tool. Composio-brokered tools (HubSpot, Stripe, Linear, …) are
        // UPPER_SNAKE slugs and are dispatched to Composio rather than dead-ending here.
        if (isComposioToolName(name)) return executeComposioTool(userId, name, args);
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
    case "create_google_task": return `Create task: "${args.title}"`;
    case "complete_google_task": return `Mark task "${args.title ?? ""}" as done`;
    case "delete_google_task": return `Delete task "${args.title ?? ""}"`;
    case "list_todoist_tasks": return "List Todoist tasks";
    case "create_todoist_task": return `Add to Todoist: "${args.content}"`;
    case "search_notion_pages": return `Search Notion for "${args.query ?? ""}"`;
    case "read_notion_page": return "Read a Notion page";
    case "create_notion_note": return `Create Notion note: "${args.title}"`;
    case "append_to_notion_page": return `Add content to Notion page${args.pageQuery ? ` "${args.pageQuery}"` : ""}`;
    case "list_notion_databases": return "List Notion databases";
    case "add_notion_database_row": return `Add "${args.title ?? "a row"}" to a Notion database`;
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
    case "create_drive_doc": {
      const to = toEmailList(args.emailTo);
      return to.length
        ? `Create document "${args.name ?? ""}" and email it to ${to.join(", ")}`
        : `Create Google Doc "${args.name ?? ""}"`;
    }
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
    case "list_spreadsheets": return "List your Google Sheets";
    case "read_sheet": return "Read a Google Sheet";
    case "send_bulk_email_from_sheet":
      return `Send "${args.subject ?? "an email"}" to people in ${
        args.spreadsheetName ? `"${args.spreadsheetName}"` : "a Google Sheet"
      }${args.fromDate || args.toDate ? ` (joined ${args.fromDate ?? "any"} → ${args.toDate ?? "any"})` : ""}`;
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
    default:
      // Composio-brokered tool — build the confirmation text from its slug + args.
      if (isComposioToolName(name)) return summarizeComposioAction(name, args);
      return `Run ${name}`;
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
  "list_spreadsheets",
  "read_sheet",
  "get_calendar_events",
  "list_google_tasks",
  "list_todoist_tasks",
  "search_notion_pages",
  "read_notion_page",
  "list_notion_databases",
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
  // Composio tools are classified by their action verb (GET_/LIST_/SEARCH_/…), defaulting
  // to WRITE — so an unrecognized connector action goes through user confirmation rather
  // than being auto-run mid-chain.
  return READ_ONLY_ACTIONS.has(name) || isComposioReadOnlyTool(name);
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

/**
 * The user pointed at an attachment ("analyze this photo…") but didn't actually send one.
 *
 * A prompt rule alone does NOT stop this — verified live: Gemini happily invents a business
 * card's contents and emails it. So we hard-block it in code before the model ever runs.
 */
const ATTACHMENT_REFERENCE_RE =
  /\b(?:this|that|the|attached|uploaded|following)\s+(?:photo|image|picture|pic|screenshot|file|document|doc|pdf|receipt|invoice|card|scan)\b|\battachment\b/i;

export function mentionsMissingAttachment(message: string, hasAttachment: boolean): boolean {
  return !hasAttachment && ATTACHMENT_REFERENCE_RE.test(message);
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

  // Hard guard: never let the model invent the contents of an attachment that wasn't sent.
  if (mentionsMissingAttachment(message, Boolean(opts.image || opts.attachment))) {
    const answer =
      "I don't see an attachment on that message — nothing came through.\n\n" +
      "Tap the **+** button to attach the photo or file, then send it again. I'll read it properly and take it from there.\n\n" +
      "I won't guess at what's in it — I'd rather ask than invent details.";
    await persistMessage(userId, "user", message, convId);
    await persistMessage(userId, "assistant", answer, convId);
    return { answer, action: null, isLive: true, conversationId: convId };
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

  // Composio tools for the toolkits this user actually connected (budgeted + cached).
  // Empty when Composio is off or nothing is connected, so the native surface is unchanged.
  const composioTools = await getComposioToolsForUser(userId);

  try {
    const outcome = await runAgentTurn({
      system: systemPrompt,
      tools: [...PERSONAL_TOOLS, ...composioTools],
      userParts: parts,
      history,
      isReadOnly: isReadOnlyAction,
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
