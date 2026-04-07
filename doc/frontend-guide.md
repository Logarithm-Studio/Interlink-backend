# Frontend Implementation Guide

**Audience**: Frontend engineers building UI against the Interlink backend.
**Backend base URL (dev)**: `http://localhost:5000` — all routes under `/api/v1/`.
**Auth**: Every request (except `/health` and the Google webhook) must include `Authorization: Bearer <Supabase access_token>`.

---

## Table of Contents

1. [What Works / What Doesn't](#1-what-works--what-doesnt)
2. [Environment Variables](#2-environment-variables)
3. [Authentication](#3-authentication)
4. [Google Calendar Connect](#4-google-calendar-connect)
5. [Calendar Sync & Events](#5-calendar-sync--events)
6. [Conflict Detection](#6-conflict-detection)
7. [Conflict Resolution Workflow (the main flow)](#7-conflict-resolution-workflow-the-main-flow)
8. [AI Email Preview Loop](#8-ai-email-preview-loop)
9. [Workflow Execution Polling](#9-workflow-execution-polling)
10. [Push Notifications (FCM)](#10-push-notifications-fcm)
11. [User Preferences](#11-user-preferences)
12. [Direct Event Operations](#12-direct-event-operations)
13. [Full API Reference](#13-full-api-reference)
14. [Error Shapes & Rate Limits](#14-error-shapes--rate-limits)

---

## 1. What Works / What Doesn't

| Feature                                                       | Status                                          |
| ------------------------------------------------------------- | ----------------------------------------------- |
| Google Calendar sync (manual + webhook)                       | ✅ Implemented                                  |
| Conflict detection                                            | ✅ Implemented                                  |
| Conflict resolution workflow (reschedule / decline / dismiss) | ✅ Implemented                                  |
| FCM push notifications                                        | ✅ Implemented (optional — falls back to email) |
| Gmail draft creation + send (multi-recipient)                 | ✅ Implemented                                  |
| AI email generation + preview + regenerate loop               | ✅ Implemented                                  |
| Auto-skip email step when no external attendees               | ✅ Implemented                                  |
| User preferences (buffer, tone, notify channel, timezone)     | ✅ Implemented                                  |
| Microsoft Graph Calendar                                      | ❌ Not implemented (returns error)              |
| Outlook Mail                                                  | ❌ Not implemented (returns error)              |
| SMS fallback                                                  | ❌ Not implemented                              |

---

## 2. Environment Variables

These are **backend** variables. Your frontend only needs the Supabase ones.

| Purpose                    | Variable                                              | Notes                                                              |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| Supabase project URL       | `SUPABASE_URL`                                        | Used by backend for JWKS JWT verification                          |
| Supabase anon key          | `SUPABASE_KEY`                                        | Also needed by frontend Supabase client                            |
| Google OAuth client ID     | `GOOGLE_CLIENT_ID`                                    | Calendar + Gmail                                                   |
| Google OAuth client secret | `GOOGLE_CLIENT_SECRET`                                | Backend exchanges auth codes                                       |
| Google OAuth redirect URI  | `GOOGLE_REDIRECT_URI`                                 | Default: `http://localhost:5000/api/v1/auth/callback/google`       |
| Google webhook URL         | `GOOGLE_WEBHOOK_URL`                                  | Must be public HTTPS (use ngrok in dev)                            |
| Token encryption key       | `ENCRYPTION_KEY`                                      | AES-256-GCM for stored OAuth tokens                                |
| Action signing secret      | `ACTION_SIGNING_SECRET`                               | Signs workflow action tokens in notifications                      |
| AI provider                | `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`               | Email draft generation                                             |
| Firebase (optional push)   | `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_KEY` | If unset, falls back to email notification                         |
| App base URL               | `APP_BASE_URL`                                        | Used in notification deep links (e.g. `https://app.interlink.com`) |

**Frontend-side env vars** (example for Next.js):

```
NEXT_PUBLIC_API_URL=http://localhost:5000
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

---

## 3. Authentication

Interlink uses **Supabase** for identity. The backend verifies Supabase JWTs locally (no round-trip to Supabase on every request).

### Sign up / Sign in

Use the Supabase JS SDK on the frontend:

```js
// Sign up
const { data, error } = await supabase.auth.signUp({ email, password });

// Sign in
const { data, error } = await supabase.auth.signInWithPassword({
  email,
  password,
});
```

### Getting a token

Always call `supabase.auth.getSession()` before making requests. The SDK auto-refreshes tokens (they expire in ~1 hour), so users never need to re-login.

```js
const {
  data: { session },
} = await supabase.auth.getSession();
const token = session?.access_token;
```

### Sample API client

```js
const API = "http://localhost:5000/api/v1";

async function apiFetch(path, options = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...options.headers,
    },
  });
  if (!res.ok) throw await res.json();
  return res.json();
}
```

### Check who is logged in + which accounts are connected

```
GET /api/v1/auth/me
```

**Response**:

```json
{
  "user": { "id": "uuid", "email": "user@example.com" },
  "connectedAccounts": {
    "google": { "connected": true, "expiresAt": "2026-03-06T..." }
  }
}
```

If `connectedAccounts.google` is `null`, show a "Connect Google" button.

---

## 4. Google Calendar Connect

Use a **server-backed OAuth flow**. For web you can keep redirect behavior; for Android/native use `GET /auth/google/start`.

### Android/native flow (recommended)

1. Call `GET /api/v1/auth/google/start` with `Authorization: Bearer <supabase_jwt>`.
2. Read `authUrl` from response.
3. Open `authUrl` in Custom Tabs / external browser.
4. After Google callback, backend redirects to your configured app deep link:
   - `GOOGLE_OAUTH_SUCCESS_REDIRECT_URI` on success
   - `GOOGLE_OAUTH_ERROR_REDIRECT_URI` on failure
5. In app deep-link handler, check query params (`status`, `provider`, optional `code`) and refresh account state via `GET /api/v1/auth/me`.

Example response from `/auth/google/start`:

```json
{
  "provider": "google",
  "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "stateTtlSeconds": 600
}
```

### Web flow (existing)

You can still call `GET /api/v1/auth/google` with auth and let backend issue an HTTP redirect to Google.

> **Important**: Google OAuth requests both `calendar` (read/write) and `gmail.compose` (draft + send) scopes. The user must accept both.

### After Google connects

Google redirects to `GOOGLE_REDIRECT_URI`. The backend exchanges the code for tokens, stores them encrypted. Backend responds:

```json
{ "message": "Google Calendar connected successfully", "provider": "google" }
```

After this, immediately:

1. Run a manual sync: `POST /api/v1/calendar/sync?provider=google`
2. Register a watch channel: `POST /api/v1/calendar/watch/google`

---

## 5. Calendar Sync & Events

### Manual sync

```
POST /api/v1/calendar/sync?provider=google
```

Optional query param: `since=<ISO date>` for incremental sync.

**Response**:

```json
{
  "message": "Calendar sync complete for google",
  "synced": 12,
  "skipped": 0,
  "deleted": 1
}
```

Call this after connecting Google, when the user taps "Refresh", or after returning from background.

### Register webhook (enables real-time conflict detection)

```
POST /api/v1/calendar/watch/google
Body: { "calendarId": "primary" }
```

**Response**:

```json
{
  "channelId": "uuid",
  "calendarId": "primary",
  "expiration": "2026-03-12T..."
}
```

Google watch channels expire in ~7 days. Re-register periodically.

### List events

```
GET /api/v1/events?from=2026-03-01T00:00:00Z&to=2026-03-31T23:59:59Z
```

**Response**:

```json
{
  "events": [
    {
      "id": "uuid",
      "title": "Team Standup",
      "startTime": "2026-03-05T09:00:00Z",
      "endTime": "2026-03-05T09:30:00Z",
      "provider": "google",
      "providerEventId": "google_event_id",
      "eventType": "meeting",
      "attendees": [
        { "email": "alice@example.com", "responseStatus": "accepted" }
      ],
      "organizerEmail": "bob@example.com",
      "isOrganizer": true
    }
  ],
  "count": 1
}
```

### Get a single event

```
GET /api/v1/events/:id
```

**Response**: `{ "event": { ...same shape as above... } }`

---

## 6. Conflict Detection

```
GET /api/v1/events/conflicts?from=<iso>&to=<iso>
```

Both params are optional.

**Response**:

```json
{
  "conflicts": [
    {
      "id": "uuid",
      "conflictType": "overlap",
      "severity": "high",
      "status": "active",
      "conflictingEvents": ["event-uuid-1", "event-uuid-2"],
      "conflictingEventDetails": [
        {
          "title": "Event A",
          "startTime": "...",
          "endTime": "...",
          "organizerEmail": "organizer@example.com"
        },
        {
          "title": "Event B",
          "startTime": "...",
          "endTime": "...",
          "organizerEmail": "other@example.com"
        }
      ]
    }
  ],
  "count": 1
}
```

**Note**: Conflict detection runs automatically after every sync and fires the conflict resolution workflow automatically. You only need this endpoint to build a dedicated conflicts list screen.

---

## 7. Conflict Resolution Workflow (the main flow)

This is the **core feature**. When a conflict is detected, the backend automatically starts a workflow execution. The frontend needs to:

1. Receive a push notification (or display a banner via polling)
2. Show the user 3 options: **Reschedule**, **Decline**, **Dismiss**
3. Collect required input and submit it via the workflow action endpoint
4. Show the AI email preview and let the user send or regenerate (**only if the conflicting events have external attendees**)
5. Optionally skip the email — workflow finishes either way

### Full flow diagram

```
[Backend detects conflict]
        |
        v
[notify_conflict step: sends push/email to user]
        |
        v
User sees: [Reschedule]    [Decline]    [Dismiss]
               |               |             |
               v               v             v
       reschedule_input   decline_input   log_dismissed
       (waiting for       (waiting for    (workflow done)
        new time)          confirmation)
               |               |
               v               v
       [Show time picker] [Show confirm dialog]
               |               |
               v               v
       do_reschedule       do_decline
       (real Google API)   (real Google API)
               |               |
               +-------+-------+
                       |
                       v
            email_generate_preview
            (AI generates draft, waits for review)
                       |
              +--------+--------+
              |                 |         |
              v                 v         v
       [Regenerate]          [Send]    [Skip]
              |                 |         |
           (loop)          send_email   done
                               |
                 [Email sent to ALL attendees
                  (excluding you as sender)]
                               |
                          log_complete
                          (workflow done)

        ─ OR, if no external attendees ─

            email_generate_preview
            (auto-skipped: no recipients)
                       |
                  log_complete
                  (workflow done)
```

### Step 1 — Receive the notification

**Via FCM push** (if Firebase is configured):

Your FCM handler receives a `data` payload (all values are strings):

```json
{
  "executionId": "uuid-of-workflow-execution",
  "stepId": "notify_conflict",
  "title": "Scheduling Conflict Detected",
  "body": "You have overlapping events. Choose an action to resolve the conflict.",
  "actions": "[{\"label\":\"Reschedule an event\",\"actionKey\":\"reschedule\",\"token\":\"...\"},{\"label\":\"Decline an event\",\"actionKey\":\"decline\",\"token\":\"...\"},{\"label\":\"Dismiss\",\"actionKey\":\"dismiss\",\"token\":\"...\"}]"
}
```

Parse `actions` with `JSON.parse(data.actions)`.

**Via email fallback** (if FCM not configured or delivery fails):

The user gets an email with links like:

```
{APP_BASE_URL}/action?token=<signed-token>
```

Handle this deep link in your app — extract the `token` param and call the workflow action endpoint (see Step 2).

### Step 2 — User picks Reschedule / Decline / Dismiss

```
POST /api/v1/workflows/actions
```

```json
{
  "executionId": "uuid",
  "stepId": "notify_conflict",
  "actionKey": "reschedule",
  "token": "<signed-token-from-notification>"
}
```

> When `token` is provided, the backend extracts `executionId`, `stepId`, and `actionKey` from the signed token — they cannot be tampered with. If no `token`, you must supply all three fields correctly.

**Response** (202 Accepted):

```json
{
  "message": "Action accepted — workflow will resume shortly",
  "executionId": "uuid",
  "stepId": "notify_conflict",
  "actionKey": "reschedule"
}
```

Action mapping:

- `"dismiss"` → workflow ends immediately (routes to `log_dismissed`)
- `"reschedule"` → workflow moves to `reschedule_input`, show a time picker
- `"decline"` → workflow moves to `decline_input`, show a confirmation screen

### Step 3A — Reschedule: let user pick an event, collect new time, submit

Poll the execution (see §9) until `currentStep === "reschedule_input"` and `status === "waiting"`.

**Show both conflicting events** from the execution context so the user can choose which one to reschedule:

```js
const { conflictingEvents, conflictingEventDetails } =
  execution.context.trigger.conflict;

// conflictingEvents  → ["event-uuid-1", "event-uuid-2"]
// conflictingEventDetails → [{ title, startTime, endTime, organizerEmail }, ...]
```

Render each event as a selectable card. Hide the reschedule option for events where the user is **not** the organizer (check `event.organizerEmail` against the logged-in user's email — only the organizer can move an event).

After the user selects an event and picks a new time:

```
POST /api/v1/workflows/actions
```

```json
{
  "executionId": "uuid",
  "stepId": "reschedule_input",
  "actionKey": "submit_reschedule",
  "payload": {
    "eventId": "db-uuid-of-the-event-the-user-chose",
    "startTime": "2026-03-06T10:00:00Z",
    "endTime": "2026-03-06T11:00:00Z",
    "title": "Optional new title",
    "calendarId": "primary"
  }
}
```

> **`eventId` must be one of the two UUIDs in `conflictingEvents`**. The backend validates this and will throw an error if a different event ID is submitted.

> **Organizer check**: Only the organizer can reschedule. If the user is not the organizer of a particular event, don't show the reschedule option for that event — show decline or dismiss only.

The backend calls the real Google Calendar API with `sendUpdates: "all"` — all attendees are notified automatically. All active conflict rows for the rescheduled event are also marked `cleared` immediately — `GET /api/v1/events/conflicts` will no longer return them.

### Step 3B — Decline: let user pick an event, confirm, and submit

Poll until `currentStep === "decline_input"` and `status === "waiting"`.

**Show both conflicting events** so the user can choose which one to remove from their calendar:

```js
const { conflictingEvents, conflictingEventDetails } =
  execution.context.trigger.conflict;
```

Render each event as a selectable card. The user taps one, then confirms the action in a dialog.

```
POST /api/v1/workflows/actions
```

```json
{
  "executionId": "uuid",
  "stepId": "decline_input",
  "actionKey": "submit_decline",
  "payload": {
    "eventId": "db-uuid-of-the-event-the-user-chose",
    "calendarId": "primary"
  }
}
```

> **`eventId` must be one of the two UUIDs in `conflictingEvents`**. The backend validates this and will throw an error if a different event ID is submitted.

Backend behavior:

- If user is **organizer**: event is deleted from Google Calendar entirely
- If user is **attendee**: response status patched to `"declined"` on Google
- Either way: event removed from local DB (no longer triggers conflicts)
- **Conflict list updated immediately**: all active conflict rows for this event are marked `cleared` straight away — `GET /api/v1/events/conflicts` will no longer return them without needing any additional sync

### Step 4 — AI email preview appears automatically

After `do_reschedule` or `do_decline` completes, the workflow automatically moves to `email_generate_preview`.

**Auto-skip case**: If neither of the conflicting events has any attendees other than you, there is nobody to notify. The step instantly skips itself and the workflow completes without showing any email UI. You can detect this because the step will never enter `waiting` status — execution goes straight to `completed`.

**Normal case** (events have external attendees): The AI generates a draft addressed to every attendee of the conflicting events (excluding you as the sender). The step pauses for review.

Poll until `currentStep === "email_generate_preview"` and `status === "waiting"`. Read the draft from:

```
execution.context.outputs.email_generate_preview.emailDraft
  → { subject: "...", body: "..." }

// Primary: array of all recipients (use this)
execution.context.outputs.email_generate_preview.recipientEmails
  → ["alice@example.com", "bob@example.com"]

// Deprecated scalar (first recipient only — kept for backwards compat)
execution.context.outputs.email_generate_preview.recipientEmail
  → "alice@example.com"
```

Show the draft with **Send**, **Regenerate**, and **Skip** buttons.

> When email is sent it goes to **all attendees in `recipientEmails`** at once (single email, `To:` lists all of them). The sender is the user's own Google account.

---

## 8. AI Email Preview Loop

Once in the `email_generate_preview` step, the user can loop as many times as needed.

### Regenerate (call AI again for a new draft)

```
POST /api/v1/workflows/actions
```

```json
{
  "executionId": "uuid",
  "stepId": "email_generate_preview",
  "actionKey": "regenerate_email",
  "payload": {
    "tonePreference": "friendly",
    "meetingNotes": "Please reschedule to after 3pm"
  }
}
```

After ~1-2 seconds, poll the execution — the new draft appears in `outputs.email_generate_preview.emailDraft`. The step stays `waiting` (loops on itself) until send or skip.

**Optional payload fields**:

| Field             | Type     | Values / Effect                                                               |
| ----------------- | -------- | ----------------------------------------------------------------------------- |
| `tonePreference`  | string   | `"professional"`, `"friendly"`, `"concise"`, `"formal"`                       |
| `meetingNotes`    | string   | Extra context added to the AI prompt                                          |
| `recipientEmails` | string[] | Override the full recipient list (replaces auto-detected attendees)           |
| `recipientEmail`  | string   | Override with a single recipient (deprecated — use `recipientEmails` instead) |

### Send

```json
{
  "executionId": "uuid",
  "stepId": "email_generate_preview",
  "actionKey": "send_email"
}
```

Approves the current draft. The backend:

1. Creates a Gmail draft
2. Immediately sends it via `users.drafts.send` (real send — not just saved as draft)
3. Advances to `log_complete` — workflow is fully done

### Skip (no email)

```json
{
  "executionId": "uuid",
  "stepId": "email_generate_preview",
  "actionKey": "skip_email"
}
```

Workflow ends without sending any email.

---

## 9. Workflow Execution Polling

### List all executions (for a dashboard)

```
GET /api/v1/workflows/executions?status=waiting&limit=20&offset=0
```

**Status values**: `pending`, `running`, `waiting`, `completed`, `failed`

**Response**:

```json
{
  "executions": [
    {
      "id": "uuid",
      "workflowId": "uuid",
      "workflowName": "Conflict Resolution",
      "status": "waiting",
      "currentStep": "email_generate_preview",
      "summary": {
        "triggerType": "calendar.conflict.detected",
        "conflictType": "overlap",
        "severity": "high",
        "conflictingEvents": [
          { "title": "Event A", "startTime": "...", "endTime": "..." },
          { "title": "Event B", "startTime": "...", "endTime": "..." }
        ]
      },
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### Get full execution detail (drives UI state)

```
GET /api/v1/workflows/executions/:id
```

**Response**:

```json
{
  "execution": {
    "id": "uuid",
    "workflowName": "Conflict Resolution",
    "triggerType": "calendar.conflict.detected",
    "status": "waiting",
    "currentStep": "email_generate_preview",
    "context": {
      "trigger": {
        "triggerType": "calendar.conflict.detected",
        "userId": "uuid",
        "conflict": {
          "id": "uuid",
          "conflictType": "overlap",
          "severity": "high",
          "isNew": true,
          "conflictingEvents": ["event-uuid-1", "event-uuid-2"],
          "conflictingEventDetails": [
            {
              "title": "Event A",
              "startTime": "...",
              "endTime": "...",
              "organizerEmail": "organizer@example.com"
            },
            {
              "title": "Event B",
              "startTime": "...",
              "endTime": "...",
              "organizerEmail": "other@example.com"
            }
          ]
        }
      },
      "outputs": {
        "notify_conflict": { "notified": true },
        "do_reschedule": {
          "rescheduled": true,
          "eventId": "uuid",
          "previousStart": "...",
          "previousEnd": "...",
          "newStart": "...",
          "newEnd": "..."
        },
        "email_generate_preview": {
          "emailDraft": {
            "subject": "Rescheduling our meeting",
            "body": "Hi Alice, I have rescheduled our meeting to..."
          },
          "recipientEmails": ["alice@example.com", "bob@example.com"],
          "recipientEmail": "alice@example.com",
          "regenerateCount": 0,
          "isFallback": false,
          "skipped": false
        }
      }
    },
    "createdAt": "...",
    "updatedAt": "..."
  },
  "steps": [
    {
      "stepId": "notify_conflict",
      "status": "completed",
      "output": { "notified": true }
    },
    { "stepId": "reschedule_input", "status": "completed", "output": {} },
    {
      "stepId": "do_reschedule",
      "status": "completed",
      "output": { "rescheduled": true }
    },
    {
      "stepId": "email_generate_preview",
      "status": "waiting",
      "output": { "emailDraft": {} }
    }
  ]
}
```

### Recommended polling pattern

```js
async function pollExecution(executionId, onUpdate) {
  const INTERVAL_MS = 2000;
  const MAX_POLLS = 60; // give up after 2 minutes

  let polls = 0;
  const timer = setInterval(async () => {
    polls++;
    const data = await apiFetch(`/workflows/executions/${executionId}`);
    onUpdate(data);

    const { status } = data.execution;
    if (
      status === "completed" ||
      status === "failed" ||
      status === "waiting" ||
      polls >= MAX_POLLS
    ) {
      clearInterval(timer);
    }
  }, INTERVAL_MS);
}
```

Stop when `status` is `completed`, `failed`, or `waiting`. When `waiting`, show the UI for the current step.

### UI state machine: what to render per step

| `currentStep`            | `status`    | Render                                         |
| ------------------------ | ----------- | ---------------------------------------------- |
| `notify_conflict`        | `waiting`   | 3 buttons: Reschedule / Decline / Dismiss      |
| `reschedule_input`       | `waiting`   | Time picker + "Submit Reschedule"              |
| `decline_input`          | `waiting`   | Confirm decline dialog                         |
| `do_reschedule`          | `running`   | "Rescheduling in Google Calendar..." spinner   |
| `do_decline`             | `running`   | "Declining in Google Calendar..." spinner      |
| `email_generate_preview` | `waiting`   | Email draft preview + Send / Regenerate / Skip |
| `send_email`             | `running`   | "Sending email..." spinner                     |
| `log_complete`           | `completed` | "Done! Conflict resolved." success             |
| `log_dismissed`          | `completed` | (no UI needed — user dismissed)                |
| `log_timeout`            | `completed` | "Notification timed out." info                 |
| any                      | `failed`    | Error — show `context._failure.reason`         |

---

## 10. Push Notifications (FCM)

### Register a device token

Call after app start and whenever the FCM token refreshes:

```
POST /api/v1/push-tokens
Body: { "token": "<fcm-token>", "platform": "ios" | "android" | "web" }
```

**Response**:

```json
{ "message": "Push token registered", "id": "uuid", "platform": "web" }
```

Idempotent — safe to call on every app launch.

### List registered tokens

```
GET /api/v1/push-tokens
```

### Remove a token (on logout or uninstall)

```
DELETE /api/v1/push-tokens/:id
```

### Handle the email fallback deep link

When FCM is unavailable, users get an email with action links:

```
{APP_BASE_URL}/action?token=<signed-token>
```

In your deep link handler:

```js
const token = new URLSearchParams(window.location.search).get("token");
if (token) {
  // token contains executionId/stepId/actionKey — just pass it through
  await apiFetch("/workflows/actions", {
    method: "POST",
    body: JSON.stringify({
      executionId: "from-token", // overridden by the token on backend
      stepId: "from-token",
      actionKey: "from-token",
      token,
    }),
  });
  // navigate to the execution detail page
}
```

---

## 11. User Preferences

### Read preferences

```
GET /api/v1/preferences
```

**Response**:

```json
{
  "preferences": {
    "defaultBufferMinutes": 15,
    "tonePreference": "professional",
    "notifyVia": "push",
    "timezone": "America/New_York",
    "updatedAt": "..."
  }
}
```

A default row is created automatically on first read.

### Update preferences (send only changed fields)

```
PUT /api/v1/preferences
Body: { "tonePreference": "friendly", "defaultBufferMinutes": 30 }
```

**Allowed values**:

| Field                  | Type    | Accepted values                                         |
| ---------------------- | ------- | ------------------------------------------------------- |
| `defaultBufferMinutes` | integer | 0–120                                                   |
| `tonePreference`       | string  | `"professional"`, `"friendly"`, `"concise"`, `"formal"` |
| `notifyVia`            | string  | `"push"`, `"email"`, `"both"`                           |
| `timezone`             | string  | IANA timezone string (e.g. `"America/New_York"`)        |

**Response**: same shape as GET, with updated values.

---

## 12. Direct Event Operations

Use these endpoints from an events list screen, bypassing the workflow system.

### Reschedule an event (organizer only)

```
PATCH /api/v1/events/:id/reschedule
Body:
{
  "startTime": "2026-03-06T10:00:00Z",
  "endTime":   "2026-03-06T11:00:00Z",
  "title":       "Optional new title",
  "description": "Optional description",
  "calendarId":  "primary"
}
```

`startTime` and `endTime` are required. Returns 403 if user is not the organizer.

**Response**: `{ "message": "Event rescheduled", "event": { ...updated event... } }`

### Decline an event

```
POST /api/v1/events/:id/decline
Body: { "calendarId": "primary" }
```

**Response**: `{ "message": "Event declined" }`

### Delete an event

```
DELETE /api/v1/events/:id
```

**Response**: `{ "message": "Event deleted" }`

---

## 13. Full API Reference

| Method | Path                               | Auth | Purpose                                     |
| ------ | ---------------------------------- | ---- | ------------------------------------------- |
| GET    | `/health`                          | None | Health check                                |
| GET    | `/api/v1/auth/me`                  | Yes  | Current user + connected accounts           |
| GET    | `/api/v1/auth/google`              | Yes  | Redirect to Google OAuth consent            |
| GET    | `/api/v1/auth/callback/google`     | None | OAuth callback (backend only)               |
| POST   | `/api/v1/calendar/sync`            | Yes  | Manual calendar sync                        |
| POST   | `/api/v1/calendar/watch/google`    | Yes  | Register Google push webhook channel        |
| POST   | `/api/v1/calendar/webhook/google`  | None | Google push events (backend only)           |
| GET    | `/api/v1/events`                   | Yes  | List events (`?from=&to=`)                  |
| GET    | `/api/v1/events/conflicts`         | Yes  | List conflicts (`?from=&to=`)               |
| GET    | `/api/v1/events/:id`               | Yes  | Get single event                            |
| PATCH  | `/api/v1/events/:id/reschedule`    | Yes  | Reschedule event (organizer only)           |
| POST   | `/api/v1/events/:id/decline`       | Yes  | Decline event                               |
| DELETE | `/api/v1/events/:id`               | Yes  | Delete event                                |
| GET    | `/api/v1/workflows/executions`     | Yes  | List executions (`?status=&limit=&offset=`) |
| GET    | `/api/v1/workflows/executions/:id` | Yes  | Execution detail + all steps                |
| POST   | `/api/v1/workflows/actions`        | Yes  | Resume a waiting workflow step              |
| GET    | `/api/v1/preferences`              | Yes  | Read user preferences                       |
| PUT    | `/api/v1/preferences`              | Yes  | Update user preferences                     |
| POST   | `/api/v1/push-tokens`              | Yes  | Register FCM device token                   |
| GET    | `/api/v1/push-tokens`              | Yes  | List device tokens                          |
| DELETE | `/api/v1/push-tokens/:id`          | Yes  | Remove device token                         |

---

## 14. Error Shapes & Rate Limits

### Error response format

```json
{ "error": "Human-readable message", "statusCode": 404 }
```

| Status | Meaning                                                     |
| ------ | ----------------------------------------------------------- |
| 400    | Bad request (validation failure, missing required field)    |
| 401    | Missing/invalid Authorization header or expired JWT         |
| 403    | Authenticated but not authorized (e.g. not event organizer) |
| 404    | Resource not found                                          |
| 429    | Rate limit exceeded                                         |
| 500    | Internal server error                                       |

### Rate limits

| Route                                  | Limit                    |
| -------------------------------------- | ------------------------ |
| `GET /api/v1/auth/google`              | 10 req / 15 min per IP   |
| `POST /api/v1/calendar/webhook/google` | 120 req / 60 sec per IP  |
| `POST /api/v1/workflows/actions`       | 30 req / 60 sec per user |

When rate-limited (429), headers are included:

```
Retry-After: 60
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 0
```

### Idempotency

The workflow action endpoint is **idempotent**. Submitting the same `(executionId, stepId, actionKey)` combination twice is safe — BullMQ deduplicates the job. Double-tapping a button does nothing harmful.
