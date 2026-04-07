# Flutter Frontend Implementation Guide

> **Status:** Backend is fully complete. No blockers remain. This guide covers everything needed to wire up the Flutter MVP against the live backend.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Setup & Authentication Headers](#2-setup--authentication-headers)
3. [App Startup — Auth State Check](#3-app-startup--auth-state-check)
4. [Connect Google Calendar](#4-connect-google-calendar)
5. [Events List Screen](#5-events-list-screen)
6. [Event Detail Screen](#6-event-detail-screen)
7. [Yes Flow — Accepting an Event](#7-yes-flow--accepting-an-event)
8. [No Flow — Declining & Sending Email](#8-no-flow--declining--sending-email)
9. [Email Templates Screen](#9-email-templates-screen)
10. [Send History UI](#10-send-history-ui)
11. [Client-Side State Model](#11-client-side-state-model)
12. [API Response Handling Rules](#12-api-response-handling-rules)
13. [Full API Reference](#13-full-api-reference)
14. [MVP Implementation Checklist](#14-mvp-implementation-checklist)

---

## 1. Architecture Overview

The backend exposes four route groups under `/api/v1`. All routes require a valid Supabase JWT passed as a Bearer token.

```
Base URL: http://<your-host>/api/v1

/auth              →  Google OAuth + account status
/calendar          →  Sync lifecycle (backend-managed, no Flutter action needed)
/events            →  Event list, detail, attendance, decline send, send logs
/email-templates   →  Template CRUD + set-default
```

### Request Flow

```
Flutter App
    │
    ├─ Supabase (get JWT on login)
    │
    └─ Backend API  (/api/v1/...)
            │
            ├─ Google Calendar  (sync, watch, webhook — backend-owned)
            └─ Gmail            (sends decline emails on your behalf)
```

### What's Backend-Owned (Flutter Does Not Touch These)

- Calendar sync and watch renewal
- Gmail draft + send pipeline
- Attendance response auto-write on decline send
- Send log writes on success/failure

---

## 2. Setup & Authentication Headers

Every API call must include the Supabase JWT:

```
Authorization: Bearer <supabase_jwt>
Content-Type: application/json
```

Get the JWT from Supabase on sign-in and attach it to every backend request. If email confirmation is enabled in your Supabase project, confirm the user before attempting password login.

### 2.1 Supabase registration + login flow (required)

This guide assumes Flutter auth is handled with `supabase_flutter` and backend auth is handled with the returned Supabase access token.

#### Register user (sign up)

```dart
final res = await supabase.auth.signUp(
  email: email.trim(),
  password: password,
);
```

If email confirmation is enabled, user must verify email before password login succeeds.

#### Login user (sign in)

```dart
final res = await supabase.auth.signInWithPassword(
  email: email.trim(),
  password: password,
);
```

#### Get JWT for backend API calls

```dart
final token = supabase.auth.currentSession?.accessToken;
```

If `token == null`, treat user as unauthenticated and route to login.

#### Attach JWT in HTTP client

```dart
headers: {
  'Authorization': 'Bearer $token',
  'Content-Type': 'application/json',
}
```

#### Token refresh behavior

- `supabase_flutter` refreshes session automatically when configured normally.
- On backend `401`, force a session re-check (`currentSession`) and retry once.
- If still unauthorized, sign out and navigate to login.

---

## 3. App Startup — Auth State Check

On every app launch, check whether the user has a connected Google account before showing any event data.

### Endpoint

```
GET /api/v1/auth/me
```

### Response

```json
{
  "googleConnected": true,
  "email": "user@gmail.com"
}
```

### Decision Logic

```
googleConnected = true   →  Navigate to Events List screen
googleConnected = false  →  Show "Connect Google Calendar" CTA
```

---

## 4. Connect Google Calendar

When `googleConnected` is `false`, show a connect button that opens the OAuth flow.

### Endpoint

```
GET /api/v1/auth/google
```

Open this URL in a WebView or external browser with the user's JWT attached. The backend handles the full OAuth callback, stores encrypted tokens, and triggers the initial calendar sync automatically.

### After OAuth Completes

Re-call `GET /api/v1/auth/me` to confirm `googleConnected = true`, then navigate to the Events List.

---

## 5. Events List Screen

### Endpoint

```
GET /api/v1/events
GET /api/v1/events?from=2026-03-01T00:00:00.000Z&to=2026-03-31T23:59:59.999Z
```

Returns upcoming events in chronological order. Optionally filter by date range using `from` and `to` query params.

### Response Shape (per event)

```json
{
  "id": "evt_abc123",
  "title": "Quarterly Planning",
  "start": "2026-03-20T10:00:00Z",
  "end": "2026-03-20T11:00:00Z",
  "timezone": "America/New_York",
  "location": "Conference Room B",
  "organizer": { "name": "Alice", "email": "alice@example.com" },
  "attendees": [...],
  "status": "confirmed",
  "attendanceResponse": null,
  "attendanceHandledAt": null
}
```

### Attendance Prompt Logic

Use `attendanceResponse` to decide whether to show the Yes/No prompt on each event card:

| `attendanceResponse` | Show Yes/No prompt?                  |
| -------------------- | ------------------------------------ |
| `null`               | ✅ Yes — user has not responded yet  |
| `"yes"`              | ❌ No — already accepted, show badge |
| `"no"`               | ❌ No — already declined, show badge |

> **Rule:** Never re-show the attendance prompt if `attendanceResponse` is non-null.

---

## 6. Event Detail Screen

### Endpoint

```
GET /api/v1/events/:id
```

### Response Shape

```json
{
  "id": "evt_abc123",
  "title": "Quarterly Planning",
  "description": "Agenda to be shared prior to meeting.",
  "start": "2026-03-20T10:00:00Z",
  "end": "2026-03-20T11:00:00Z",
  "timezone": "America/New_York",
  "location": "Conference Room B",
  "organizer": { "name": "Alice", "email": "alice@example.com" },
  "attendees": [
    { "name": "Bob", "email": "bob@example.com", "responseStatus": "accepted" }
  ],
  "status": "confirmed",
  "attendanceResponse": "yes",
  "attendanceHandledAt": "2026-03-15T08:30:00Z"
}
```

### UI Guidance

- Use `attendanceResponse` to render a status badge ("Accepted" / "Declined").
- Use `attendanceHandledAt` for a "Responded on [date]" label if needed.
- If `attendanceResponse` is `null`, show the Yes/No prompt.

---

## 7. Yes Flow — Accepting an Event

Tapping **Yes** only records the attendance. No email is sent.

### Endpoint

```
POST /api/v1/events/:id/attendance-response
```

### Request Body

```json
{ "response": "yes" }
```

### On `200` Success

- Set local `attendanceResponse = "yes"`.
- Dismiss the attendance prompt.
- No further API calls needed.

---

## 8. No Flow — Declining & Sending Email

Tapping **No** sends the decline email and records the `no` attendance response in a **single call**. You do not need to separately call the attendance endpoint.

### Endpoint

```
POST /api/v1/events/:id/send-decline-email
```

### Request Body (all fields optional)

```json
{
  "templateId": "system-default",
  "customSubject": "Unable to attend",
  "customBody": "Hi, I won't be able to make it.",
  "sendToOrganizer": true,
  "sendToAttendees": true
}
```

| Field             | Default           | Notes                                          |
| ----------------- | ----------------- | ---------------------------------------------- |
| `templateId`      | effective default | Use `"system-default"` or a custom template ID |
| `customSubject`   | from template     | Overrides template subject if provided         |
| `customBody`      | from template     | Overrides template body if provided            |
| `sendToOrganizer` | `true`            |                                                |
| `sendToAttendees` | `true`            |                                                |

### What the Backend Does Automatically

1. Loads event context from the database.
2. Resolves recipients from organizer and attendees (excludes the authenticated user's own email).
3. Applies selected template or falls back to the effective default.
4. Renders subject/body with event placeholders.
5. Sends via Gmail.
6. Writes a send log (`sent` or `failed`).
7. **Automatically records `attendanceResponse = "no"`** — no separate call needed.

### Success Response

```json
{
  "messageId": "msg_xyz",
  "threadId": "thread_xyz",
  "recipients": ["alice@example.com"],
  "status": "sent"
}
```

### Flutter Actions on `200`

- Set local `attendanceResponse = "no"`.
- Set `declineSendStatus = "sent"`.
- Show success toast ("Decline email sent").
- Optionally refresh event detail to reflect updated attendance state.

> **Important:** The event is NOT removed from the list or detail APIs after declining. It remains visible.

### Optional: Pre-fill the Decline UI

Before showing a compose/preview screen, fetch the current default template to pre-populate subject and body fields:

```
GET /api/v1/email-templates/effective-default
```

---

## 9. Email Templates Screen

### List All Templates

```
GET /api/v1/email-templates
```

### Response

```json
[
  {
    "id": "system-default",
    "name": "Default Template",
    "subjectTemplate": "Unable to attend: {{eventTitle}}",
    "bodyTemplate": "Hi {{organizerName}}, I won't be able to attend {{eventTitle}}.",
    "isDefault": true,
    "isSystem": true
  },
  {
    "id": "tmpl_abc",
    "name": "My Custom Template",
    "subjectTemplate": "Can't make it: {{eventTitle}}",
    "bodyTemplate": "...",
    "isDefault": false,
    "isSystem": false
  }
]
```

### Template UI Rules

| Template type                       | Edit         | Delete | Set as Default |
| ----------------------------------- | ------------ | ------ | -------------- |
| `isSystem: true` (`system-default`) | ❌ Read-only | ❌     | ✅ Allowed     |
| `isSystem: false` (custom)          | ✅           | ✅     | ✅             |

> Always check `isSystem: true` to enforce read-only state. Do not render edit/delete buttons for system templates.

### Create Custom Template

```
POST /api/v1/email-templates
```

```json
{
  "name": "My Decline Template",
  "subjectTemplate": "Unable to attend: {{eventTitle}}",
  "bodyTemplate": "Hi, I will not be able to attend {{eventTitle}} at {{eventStart}}.",
  "isActiveDefault": true
}
```

### Edit Custom Template

```
PATCH /api/v1/email-templates/:id
```

```json
{
  "name": "Updated Template Name",
  "bodyTemplate": "Updated body text."
}
```

Any subset of fields can be sent — only provided fields are updated.

### Delete Custom Template

```
DELETE /api/v1/email-templates/:id
```

### Set Active Default

Works for both `system-default` and any custom template ID.

```
POST /api/v1/email-templates/:id/set-default
POST /api/v1/email-templates/system-default/set-default
```

---

## 10. Send History UI

Show per-event send logs to give the user visibility into past decline emails.

### Endpoint

```
GET /api/v1/events/:id/decline-email-logs
```

### Response

```json
[
  {
    "id": "log_abc",
    "eventId": "evt_abc123",
    "status": "sent",
    "recipients": ["alice@example.com"],
    "sentAt": "2026-03-15T08:31:00Z",
    "error": null
  }
]
```

### Status Chip Mapping

| `status`       | Label          | Suggested color |
| -------------- | -------------- | --------------- |
| `sent`         | ✅ Sent        | Green           |
| `already_sent` | ↩ Already Sent | Grey            |
| `failed`       | ❌ Failed      | Red             |

Render entries newest-first. Show `sentAt` alongside the status chip.

---

## 11. Client-Side State Model

Maintain this state per event in your local state management layer (Riverpod, BLoC, Provider, etc.):

```dart
class EventAttendanceState {
  final String? attendanceResponse;    // null | "yes" | "no"
  final DateTime? attendanceHandledAt; // null if not yet responded
  final DeclineSendStatus declineSendStatus;
  final String? declineLastError;
}

enum DeclineSendStatus { idle, sending, sent, failed }
```

### State Transitions

**Yes button tapped:**

```
idle
  → set declineSendStatus = sending  (optimistic)
  → POST /attendance-response { response: "yes" }
  → on 200: attendanceResponse = "yes", dismiss prompt
  → on error: show error, stay on screen
```

**No button tapped:**

```
idle
  → set declineSendStatus = sending
  → POST /send-decline-email
  → on 200: attendanceResponse = "no", declineSendStatus = sent, show toast
  → on 4xx/5xx: declineSendStatus = failed, declineLastError = error message, show retry CTA
```

---

## 12. API Response Handling Rules

| HTTP Status                    | Meaning                             | Flutter action                                   |
| ------------------------------ | ----------------------------------- | ------------------------------------------------ |
| `200` on GET                   | Data ready                          | Render directly                                  |
| `200` on `attendance-response` | Attendance recorded                 | Set local prompt state to handled                |
| `200` on `send-decline-email`  | Email sent + attendance set to `no` | Toast success, update local state                |
| `400`                          | Validation error                    | Show `error` field message to user               |
| `401`                          | Session expired or invalid          | Force re-auth — clear session, navigate to login |
| `404`                          | Event not found                     | Pop detail screen, trigger list refresh          |
| `5xx`                          | Server error                        | Show retry CTA, keep user on current screen      |

**Error response shape:**

```json
{
  "error": "Human-readable error message describing what went wrong."
}
```

---

## 13. Full API Reference

### Auth

| Method | Endpoint              | Description                  |
| ------ | --------------------- | ---------------------------- |
| `GET`  | `/api/v1/auth/google` | Start Google OAuth flow      |
| `GET`  | `/api/v1/auth/me`     | Get connected account status |

### Events

| Method | Endpoint                                 | Description                                         |
| ------ | ---------------------------------------- | --------------------------------------------------- |
| `GET`  | `/api/v1/events`                         | Upcoming events list (chronological)                |
| `GET`  | `/api/v1/events/:id`                     | Full event detail                                   |
| `POST` | `/api/v1/events/:id/attendance-response` | Record yes/no attendance                            |
| `POST` | `/api/v1/events/:id/send-decline-email`  | Send decline email + auto-record attendance as `no` |
| `GET`  | `/api/v1/events/:id/decline-email-logs`  | Per-event send history                              |

### Email Templates

| Method   | Endpoint                                    | Description                    |
| -------- | ------------------------------------------- | ------------------------------ |
| `GET`    | `/api/v1/email-templates`                   | List all templates             |
| `GET`    | `/api/v1/email-templates/effective-default` | Resolve current active default |
| `POST`   | `/api/v1/email-templates`                   | Create custom template         |
| `PATCH`  | `/api/v1/email-templates/:id`               | Edit custom template           |
| `DELETE` | `/api/v1/email-templates/:id`               | Delete custom template         |
| `POST`   | `/api/v1/email-templates/:id/set-default`   | Set active default             |

---

## 14. MVP Implementation Checklist

Work through these in order. Each item links back to the relevant section above.

- [ ] **[§3]** App startup — call `GET /auth/me`, branch on `googleConnected`
- [ ] **[§4]** Connect Google CTA — open `GET /auth/google` in WebView, re-check auth on return
- [ ] **[§5]** Events list — fetch `GET /events`, render cards with attendance-aware prompt logic
- [ ] **[§6]** Event detail — fetch `GET /events/:id`, render full metadata and attendance badge
- [ ] **[§7]** Yes button — call `POST /events/:id/attendance-response` with `{ response: "yes" }`, dismiss prompt
- [ ] **[§8]** No button — call `POST /events/:id/send-decline-email`, handle `sent` / `failed` states with retry
- [ ] **[§8]** Optional pre-fill — fetch `GET /email-templates/effective-default` before showing compose UI
- [ ] **[§9]** Templates screen — list, create, edit, delete, set-default with read-only guard on `isSystem`
- [ ] **[§10]** Send history — fetch `GET /events/:id/decline-email-logs`, render status chips
- [ ] **Final** — E2E validation: full attendance + decline flow from login to sent email confirmation
