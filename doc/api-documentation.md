# Interlink API Documentation

**Base URL:** `https://interlink-eight.vercel.app`

Interlink is an AI-Based Calendar & Task Automation Platform. This document covers every backend API endpoint, including request/response formats and implementation guidance.

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Google OAuth](#2-google-oauth)
3. [Calendar Sync](#3-calendar-sync)
4. [Events](#4-events)
5. [Email Templates](#5-email-templates)
6. [User Preferences](#6-user-preferences)
7. [Workflows](#7-workflows)
8. [Error Handling](#8-error-handling)

---

## Common Headers

All authenticated endpoints require the `Authorization` header:

```
Authorization: Bearer <access_token>
```

The `access_token` is obtained from the [Login](#12-login) or [Signup](#11-signup) endpoint.

For endpoints that accept a JSON body, include:

```
Content-Type: application/json
```

---

## 1. Authentication

### 1.0 Health Check

Verify the API server is running.

```
GET /health
```

**Authentication:** Not required

**Response `200 OK`:**
```json
{
  "status": "ok",
  "timestamp": "2026-04-02T17:00:00.000Z"
}
```

---

### 1.1 Signup

Register a new user account.

```
POST /api/v1/auth/signup
```

**Authentication:** Not required

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | ✅ | Valid email address |
| `password` | string | ✅ | Minimum 6 characters |

**Example Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123"
}
```

**Response `201 Created`:**
```json
{
  "message": "User registered successfully",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com"
  },
  "session": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "v1.MTA3OTc5...",
    "expiresIn": 3600,
    "expiresAt": 1743620000,
    "tokenType": "bearer"
  },
  "confirmationRequired": false
}
```

> **Note:** If email confirmation is enabled in Supabase, `session` will be `null` and `confirmationRequired` will be `true`. The user must confirm their email before logging in.

**Error Responses:**
- `400` — Invalid email format, password too short, or email already registered

---

### 1.2 Login

Sign in with email and password. Returns a JWT access token.

```
POST /api/v1/auth/login
```

**Authentication:** Not required

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | ✅ | Registered email address |
| `password` | string | ✅ | Account password |

**Example Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123"
}
```

**Response `200 OK`:**
```json
{
  "message": "Login successful",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com"
  },
  "session": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "v1.MTA3OTc5...",
    "expiresIn": 3600,
    "expiresAt": 1743620000,
    "tokenType": "bearer"
  }
}
```

> **Implementation:** Store `accessToken` in memory and `refreshToken` securely (e.g., Flutter secure storage). Use the access token as `Bearer <accessToken>` in all subsequent API calls.

**Error Responses:**
- `400` — Missing or invalid email/password format
- `401` — Invalid credentials

---

### 1.3 Refresh Token

Exchange an expired access token for a new one using the refresh token.

```
POST /api/v1/auth/refresh-token
```

**Authentication:** Not required

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `refreshToken` | string | ✅ | The refresh token from login/signup |

**Example Request:**
```json
{
  "refreshToken": "v1.MTA3OTc5..."
}
```

**Response `200 OK`:**
```json
{
  "message": "Token refreshed",
  "session": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "v1.NEW_REFRESH...",
    "expiresIn": 3600,
    "expiresAt": 1743623600,
    "tokenType": "bearer"
  }
}
```

> **Implementation:** Call this endpoint when you receive a `401` response on any authenticated endpoint. Replace both the stored access token and refresh token with the new values.

**Error Responses:**
- `400` — Missing refresh token
- `401` — Invalid or expired refresh token

---

### 1.4 Get Current User

Returns the authenticated user's info and connected account status.

```
GET /api/v1/auth/me
```

**Authentication:** Required

**Response `200 OK`:**
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com"
  },
  "connectedAccounts": {
    "google": {
      "connected": true,
      "expiresAt": "2026-04-02T18:00:00.000Z"
    }
  }
}
```

If Google is not connected, `connectedAccounts.google` will be `null`.

> **Implementation:** Call this after login to check if the user needs to connect their Google account. If `google` is `null`, show a "Connect Google Calendar" button that calls the [Google OAuth Start](#21-start-google-oauth) endpoint.

---

## 2. Google OAuth

### 2.1 Start Google OAuth

Returns the Google OAuth consent URL. The client should open this URL in a browser or Custom Tab.

```
GET /api/v1/auth/google/start
```

**Authentication:** Required

**Response `200 OK`:**
```json
{
  "provider": "google",
  "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "stateTtlSeconds": 600
}
```

> **Implementation (Flutter/Mobile):**
> 1. Call this endpoint to get the `authUrl`
> 2. Open `authUrl` in a Chrome Custom Tab (Android) or SFSafariViewController (iOS)
> 3. User completes Google consent
> 4. Google redirects to the callback endpoint on your backend
> 5. Backend stores the tokens and triggers initial calendar sync
> 6. After the redirect completes, call `GET /api/v1/auth/me` to verify connection

---

### 2.2 Google OAuth Redirect (Browser Flow)

Alternative to the Start endpoint — redirects the browser directly to Google consent.

```
GET /api/v1/auth/google
```

**Authentication:** Required

**Response:** `302 Redirect` to Google's OAuth consent page.

> **Note:** This is primarily for web/browser flows. For mobile apps, use [Start Google OAuth](#21-start-google-oauth) instead.

---

### 2.3 Google OAuth Callback

Google redirects here after user consent. **Do not call this directly** — it's handled automatically by Google's redirect.

```
GET /api/v1/auth/callback/google
```

**Authentication:** Not required (uses OAuth state token)

**What happens internally:**
1. Exchanges the authorization code for Google tokens
2. Stores encrypted tokens in the database
3. Enqueues an initial calendar sync job
4. Optionally creates a Google Calendar watch channel

---

## 3. Calendar Sync

### 3.1 Manual Calendar Sync

Trigger a full calendar sync for the authenticated user. Pulls all events from Google Calendar into the local database.

```
POST /api/v1/calendar/sync?provider=google
```

**Authentication:** Required

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | `google` | Calendar provider (`google` only in Phase 1) |
| `since` | string (ISO date) | — | Optional. Only sync events modified after this date |

**Response `200 OK`:**
```json
{
  "message": "Calendar sync complete for google",
  "eventsUpserted": 15,
  "eventsDeleted": 0,
  "syncToken": "CPDAlvWD..."
}
```

> **Implementation:** Call this endpoint:
> - After a user first connects Google Calendar
> - When the user manually pulls to refresh
> - Periodically as a background task (though webhooks handle real-time updates)

**Error Responses:**
- `400` — Unsupported provider (e.g., `microsoft`)
- `401` — Google account not connected or token expired

---

### 3.2 Create Watch Channel

Register a Google Calendar push-notification channel. Google will POST to the webhook endpoint when calendar events change.

```
POST /api/v1/calendar/watch/google
```

**Authentication:** Required

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `calendarId` | string | No | `"primary"` | Google Calendar ID to watch |

**Example Request:**
```json
{
  "calendarId": "primary"
}
```

**Response `201 Created`:**
```json
{
  "message": "Watch channel created",
  "channelId": "a1b2c3d4-...",
  "calendarId": "primary",
  "expiration": "2026-04-09T17:00:00.000Z"
}
```

> **Note:** Requires `GOOGLE_WEBHOOK_URL` environment variable to be set to a publicly reachable HTTPS URL.

**Error Responses:**
- `400` — Google account not connected
- `401` — Google account requires re-authentication

---

### 3.3 Google Webhook Receiver

Public endpoint where Google posts calendar change notifications. **Do not call this manually** — it's triggered by Google.

```
POST /api/v1/calendar/webhook/google
```

**Authentication:** Not required (verified via channel token)

**What happens internally:**
1. Returns `200` immediately (Google requires reply within 10 seconds)
2. Validates the channel ID and token against stored channels
3. Deduplicates notifications
4. Enqueues a sync job via BullMQ

---

## 4. Events

All event endpoints require authentication.

### 4.1 List Events

Get upcoming events for the authenticated user. By default returns events ending after the current time.

```
GET /api/v1/events
```

**Authentication:** Required

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `from` | string (ISO date) | Now | Show events ending after this date |
| `to` | string (ISO date) | — | Show events starting before this date |

**Example:** Get events for April 2026:
```
GET /api/v1/events?from=2026-04-01T00:00:00.000Z&to=2026-04-30T23:59:59.999Z
```

**Response `200 OK`:**
```json
{
  "events": [
    {
      "id": "d4f7a1b2-...",
      "googleEventId": "abc123def456",
      "title": "Team Standup",
      "description": "Daily sync meeting",
      "startTime": "2026-04-03T09:00:00.000Z",
      "endTime": "2026-04-03T09:30:00.000Z",
      "timezone": "America/New_York",
      "location": "Conference Room A",
      "status": "confirmed",
      "isCancelled": false,
      "organizerEmail": "manager@company.com",
      "attendeeCount": 5,
      "isRecurring": true,
      "attendanceResponse": null
    }
  ],
  "count": 1,
  "filters": {
    "from": "2026-04-01T00:00:00.000Z",
    "to": "2026-04-30T23:59:59.999Z",
    "upcomingOnly": true
  }
}
```

> **Implementation:** 
> - `attendanceResponse` is `null` if the user hasn't responded yet, `"yes"` or `"no"` if they have
> - Use this to show/hide the attendance prompt in the UI
> - Call [Calendar Sync](#31-manual-calendar-sync) first if this returns empty after connecting Google

---

### 4.2 Get Event Detail

Get full details for a single event.

```
GET /api/v1/events/:id
```

**Authentication:** Required

**Path Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `id` | UUID | Event ID from the events list |

**Response `200 OK`:**
```json
{
  "event": {
    "id": "d4f7a1b2-...",
    "googleEventId": "abc123def456",
    "provider": "google",
    "title": "Team Standup",
    "description": "Daily sync meeting",
    "startTime": "2026-04-03T09:00:00.000Z",
    "endTime": "2026-04-03T09:30:00.000Z",
    "timezone": "America/New_York",
    "location": "Conference Room A",
    "status": "confirmed",
    "isCancelled": false,
    "organizerEmail": "manager@company.com",
    "attendeeEmails": ["user1@company.com", "user2@company.com"],
    "attendees": [
      {
        "email": "user1@company.com",
        "displayName": "User One",
        "responseStatus": "accepted",
        "self": false
      }
    ],
    "isRecurring": true,
    "attendanceResponse": "yes",
    "attendanceHandledAt": "2026-04-02T17:20:00.000Z"
  }
}
```

**Error Responses:**
- `404` — Event not found

---

### 4.3 Record Attendance Response

Record the user's Yes/No attendance decision for an event. Prevents repeated prompts.

```
POST /api/v1/events/:id/attendance-response
```

**Authentication:** Required

**Path Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `id` | UUID | Event ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `response` | string | ✅ | `"yes"` or `"no"` |

**Example Request:**
```json
{
  "response": "yes"
}
```

**Response `200 OK`:**
```json
{
  "message": "Attendance response recorded",
  "eventId": "d4f7a1b2-...",
  "response": "yes",
  "handledAt": "2026-04-02T17:20:00.000Z"
}
```

> **Implementation:**
> - Call this for the **"Yes" button**: `{ "response": "yes" }`
> - For the **"No" button**: call [Send Decline Email](#45-send-decline-email) instead (it auto-records `"no"`)
> - This endpoint is idempotent — calling it again updates the response

**Error Responses:**
- `400` — Invalid response value (only `"yes"` or `"no"` accepted)
- `404` — Event not found

---

### 4.4 Get Decline Email Logs

Lists the decline email send history for a specific event.

```
GET /api/v1/events/:id/decline-email-logs
```

**Authentication:** Required

**Path Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `id` | UUID | Event ID |

**Response `200 OK`:**
```json
{
  "logs": [
    {
      "status": "sent",
      "recipientEmail": "organizer@company.com",
      "sentAt": "2026-04-02T17:25:00.000Z"
    }
  ],
  "count": 1
}
```

---

### 4.5 Send Decline Email

Send a decline email for an event. Uses the user's connected Gmail account to send.

```
POST /api/v1/events/:id/send-decline-email
```

**Authentication:** Required

**Path Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `id` | UUID | Event ID |

**Request Body** (all fields optional):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `templateId` | string | User's active default | Template UUID or `"system-default"` |
| `customSubject` | string | — | Override template subject (1–500 chars) |
| `customBody` | string | — | Override template body (1–10,000 chars) |
| `sendToOrganizer` | boolean | `true` | Send email to the event organizer |
| `sendToAttendees` | boolean | `false` | Send email to other attendees |

**Example — Use default template:**
```json
{}
```

**Example — Custom message:**
```json
{
  "customSubject": "Unable to attend the meeting",
  "customBody": "Hi, I will not be able to attend this meeting. Thank you."
}
```

**Example — Specific template with recipient options:**
```json
{
  "templateId": "system-default",
  "sendToOrganizer": true,
  "sendToAttendees": true
}
```

**Response `200 OK`:**
```json
{
  "message": "Decline email processed",
  "status": "sent",
  "recipientCount": 1
}
```

> **Implementation:** On successful send, the backend automatically records the attendance response as `"no"`. No need to call the attendance endpoint separately.

**Error Responses:**
- `400` — Validation error (e.g., empty `customSubject`)
- `401` — Google authorization failed; user must reconnect
- `404` — Event not found

---

## 5. Email Templates

All template endpoints require authentication. Each user can create custom decline email templates with placeholder variables.

**Available template variables:** `{{eventTitle}}`, `{{eventStart}}`, `{{eventEnd}}`, `{{organizerEmail}}`

### 5.1 List Templates

Get all email templates for the authenticated user.

```
GET /api/v1/email-templates
```

**Authentication:** Required

**Response `200 OK`:**
```json
{
  "templates": [
    {
      "id": "template-uuid-...",
      "name": "Polite Decline",
      "subjectTemplate": "Unable to attend: {{eventTitle}}",
      "bodyTemplate": "Hi, I cannot attend {{eventTitle}} on {{eventStart}}.",
      "isActiveDefault": true,
      "createdAt": "2026-04-01T10:00:00.000Z",
      "updatedAt": "2026-04-01T10:00:00.000Z"
    }
  ],
  "count": 1
}
```

---

### 5.2 Get Effective Default Template

Returns the template that will be used when no specific template is specified in the decline email request.

```
GET /api/v1/email-templates/effective-default
```

**Authentication:** Required

**Response `200 OK`:**
```json
{
  "id": "system-default",
  "name": "System Default",
  "subjectTemplate": "Unable to attend: {{eventTitle}}",
  "bodyTemplate": "Hi, I will not be able to attend {{eventTitle}} scheduled for {{eventStart}}.",
  "source": "system"
}
```

The `source` field indicates if the effective template is `"system"` (built-in) or `"user"` (custom).

---

### 5.3 Create Template

Create a new custom email template.

```
POST /api/v1/email-templates
```

**Authentication:** Required

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Template name (1–120 chars) |
| `subjectTemplate` | string | ✅ | Email subject with placeholders (1–500 chars) |
| `bodyTemplate` | string | ✅ | Email body with placeholders (1–10,000 chars) |
| `isActiveDefault` | boolean | No | Set as the default template |

**Example Request:**
```json
{
  "name": "Professional Decline",
  "subjectTemplate": "Regrets: {{eventTitle}}",
  "bodyTemplate": "Dear team,\n\nI regret to inform you that I will be unable to attend {{eventTitle}} on {{eventStart}}.\n\nBest regards",
  "isActiveDefault": true
}
```

**Response `201 Created`:**
```json
{
  "message": "Template created",
  "template": {
    "id": "new-template-uuid",
    "name": "Professional Decline",
    "subjectTemplate": "Regrets: {{eventTitle}}",
    "bodyTemplate": "Dear team,\n\n...",
    "isActiveDefault": true,
    "createdAt": "2026-04-02T17:30:00.000Z",
    "updatedAt": "2026-04-02T17:30:00.000Z"
  }
}
```

---

### 5.4 Update Template

Partially update an existing custom template. Only include fields you want to change.

```
PATCH /api/v1/email-templates/:id
```

**Authentication:** Required

**Path Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `id` | UUID | Template ID |

**Request Body** (at least one field required):

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | New template name |
| `subjectTemplate` | string | New subject template |
| `bodyTemplate` | string | New body template |

**Example Request:**
```json
{
  "bodyTemplate": "Hello,\n\nI cannot attend {{eventTitle}}. Sorry for the inconvenience."
}
```

**Response `200 OK`:**
```json
{
  "message": "Template updated",
  "template": { ... }
}
```

**Error Responses:**
- `400` — Cannot edit the `system-default` template, or no fields provided
- `404` — Template not found

---

### 5.5 Set Default Template

Set a specific template as the active default for decline emails.

```
POST /api/v1/email-templates/:id/set-default
```

**Authentication:** Required

**Path Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `id` | UUID or `system-default` | Template ID to set as default |

**Response `200 OK`:**
```json
{
  "message": "Default template updated",
  "template": { ... }
}
```

> To reset back to the system default: `POST /api/v1/email-templates/system-default/set-default`

---

### 5.6 Delete Template

Delete a custom template. Cannot delete the system default.

```
DELETE /api/v1/email-templates/:id
```

**Authentication:** Required

**Path Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `id` | UUID | Template ID |

**Response `200 OK`:**
```json
{
  "message": "Template deleted"
}
```

**Error Responses:**
- `400` — Cannot delete `system-default`
- `404` — Template not found

---

## 6. User Preferences

### 6.1 Get Preferences

Returns user preferences. Automatically creates default preferences if none exist.

```
GET /api/v1/preferences
```

**Authentication:** Required

**Response `200 OK`:**
```json
{
  "preferences": {
    "defaultBufferMinutes": 15,
    "tonePreference": "professional",
    "notifyVia": "push",
    "timezone": null,
    "updatedAt": "2026-04-02T17:00:00.000Z"
  }
}
```

**Fields:**

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `defaultBufferMinutes` | number | 0–120 | Buffer time for conflict detection |
| `tonePreference` | string | `professional`, `friendly`, `concise`, `formal` | AI email generation tone |
| `notifyVia` | string | `push`, `email`, `both` | Notification delivery method |
| `timezone` | string \| null | IANA timezone (e.g., `America/New_York`) | User's timezone |

---

### 6.2 Update Preferences

Partial update — only provided fields are changed.

```
PUT /api/v1/preferences
```

**Authentication:** Required

**Request Body** (at least one field required):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `defaultBufferMinutes` | number | No | 0–120 |
| `tonePreference` | string | No | `professional`, `friendly`, `concise`, `formal` |
| `notifyVia` | string | No | `push`, `email`, `both` |
| `timezone` | string | No | IANA timezone string |

**Example — Update timezone only:**
```json
{
  "timezone": "America/New_York"
}
```

**Example — Update multiple fields:**
```json
{
  "defaultBufferMinutes": 30,
  "tonePreference": "friendly",
  "notifyVia": "both",
  "timezone": "Asia/Dhaka"
}
```

**Response `200 OK`:**
```json
{
  "message": "Preferences updated",
  "preferences": {
    "defaultBufferMinutes": 30,
    "tonePreference": "friendly",
    "notifyVia": "both",
    "timezone": "Asia/Dhaka",
    "updatedAt": "2026-04-02T17:35:00.000Z"
  }
}
```

**Error Responses:**
- `400` — Empty body or invalid field values

---

## 7. Workflows

Workflows are automated processes triggered by calendar events (e.g., conflict detection). They run in the background and may pause to wait for user input.

### 7.1 List Workflow Executions

Get workflow executions for the authenticated user.

```
GET /api/v1/workflows/executions
```

**Authentication:** Required

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string | — | Filter: `pending`, `running`, `waiting`, `completed`, `failed` |
| `limit` | number | 20 | Results per page (max 100) |
| `offset` | number | 0 | Pagination offset |

**Example:** Get only workflows waiting for input:
```
GET /api/v1/workflows/executions?status=waiting&limit=10
```

**Response `200 OK`:**
```json
{
  "executions": [
    {
      "id": "exec-uuid-...",
      "workflowId": "workflow-uuid-...",
      "workflowName": "Calendar Conflict Resolution",
      "status": "waiting",
      "currentStep": "wait_for_input",
      "summary": {
        "triggerType": "calendar.conflict.detected",
        "conflictType": "time_overlap",
        "severity": "hard",
        "conflictingEvents": [
          {
            "title": "Team Meeting",
            "startTime": "2026-04-03T09:00:00.000Z",
            "endTime": "2026-04-03T10:00:00.000Z"
          },
          {
            "title": "Client Call",
            "startTime": "2026-04-03T09:30:00.000Z",
            "endTime": "2026-04-03T10:30:00.000Z"
          }
        ]
      },
      "createdAt": "2026-04-02T17:00:00.000Z",
      "updatedAt": "2026-04-02T17:01:00.000Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

---

### 7.2 Get Execution Detail

Get full details for a single workflow execution, including step history.

```
GET /api/v1/workflows/executions/:id
```

**Authentication:** Required

**Path Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `id` | UUID | Execution ID |

**Response `200 OK`:**
```json
{
  "execution": {
    "id": "exec-uuid-...",
    "workflowId": "workflow-uuid-...",
    "workflowName": "Calendar Conflict Resolution",
    "triggerType": "calendar.conflict.detected",
    "status": "waiting",
    "currentStep": "wait_for_input",
    "context": { ... },
    "createdAt": "2026-04-02T17:00:00.000Z",
    "updatedAt": "2026-04-02T17:01:00.000Z"
  },
  "steps": [
    {
      "stepId": "detect_conflict",
      "status": "completed",
      "attempt": 1,
      "output": { ... },
      "error": null,
      "startedAt": "2026-04-02T17:00:00.000Z",
      "finishedAt": "2026-04-02T17:00:01.000Z",
      "nextRunAt": null
    },
    {
      "stepId": "wait_for_input",
      "status": "waiting",
      "attempt": 1,
      "output": {},
      "error": null,
      "startedAt": "2026-04-02T17:00:01.000Z",
      "finishedAt": null,
      "nextRunAt": null
    }
  ]
}
```

**Error Responses:**
- `404` — Execution not found

---

### 7.3 Submit Workflow Action

Resume a workflow execution that is waiting for user input.

```
POST /api/v1/workflows/actions
```

**Authentication:** Required

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `executionId` | UUID | ✅ | Workflow execution ID |
| `stepId` | string | ✅ | Step that is currently waiting (from notification) |
| `actionKey` | string | ✅ | Action the user chose (e.g., `"keep_event_a"`) |
| `payload` | object | No | Additional data (e.g., reschedule time) |
| `token` | string | No | Signed action token from notification deep link |

**Example Request:**
```json
{
  "executionId": "exec-uuid-...",
  "stepId": "wait_for_input",
  "actionKey": "keep_event_a",
  "payload": {}
}
```

**Response `202 Accepted`:**
```json
{
  "message": "Action accepted — workflow will resume shortly",
  "executionId": "exec-uuid-...",
  "stepId": "wait_for_input",
  "actionKey": "keep_event_a"
}
```

> **Implementation:** The workflow resumes asynchronously via BullMQ. Poll the [execution detail](#72-get-execution-detail) endpoint to check the updated status. The `202` response means the action was accepted and queued, not that the workflow has completed.

**Error Responses:**
- `400` — Execution is not in `waiting` state, or invalid body
- `401` — Invalid action token, or execution belongs to another user
- `404` — Execution not found

---

## 8. Error Handling

All error responses follow a consistent JSON format:

```json
{
  "error": "Human-readable error message"
}
```

### HTTP Status Codes

| Code | Meaning | When |
|------|---------|------|
| `200` | OK | Successful read or update |
| `201` | Created | Successful resource creation |
| `202` | Accepted | Action queued for async processing |
| `400` | Bad Request | Validation error, missing fields, or invalid input |
| `401` | Unauthorized | Missing/invalid/expired JWT, or Google re-auth needed |
| `403` | Forbidden | Insufficient permissions (e.g., editing another user's event) |
| `404` | Not Found | Resource does not exist or doesn't belong to the user |
| `429` | Too Many Requests | Rate limit exceeded |
| `500` | Internal Server Error | Unexpected server failure |

### Rate Limits

| Endpoint Group | Limit | Window |
|----------------|-------|--------|
| Signup / Login / Refresh | 20 requests | 15 minutes (per IP) |
| OAuth Connect / Callback | 10 requests | 15 minutes (per IP) |
| Webhook | 120 requests | 1 minute (per IP) |
| Workflow Actions | 30 requests | 1 minute (per user) |

When rate-limited, the response includes:
```
HTTP 429
Retry-After: <seconds>
X-RateLimit-Limit: <max>
X-RateLimit-Remaining: 0
```

---

## Implementation Flow (Recommended Order)

```
1. POST /api/v1/auth/signup          → Create account
2. POST /api/v1/auth/login           → Get JWT
3. GET  /api/v1/auth/me              → Check Google connection
4. GET  /api/v1/auth/google/start    → Connect Google Calendar
5. POST /api/v1/calendar/sync        → Pull events
6. GET  /api/v1/events               → Display event list
7. GET  /api/v1/events/:id           → Show event detail
8. POST /api/v1/events/:id/attendance-response   → "Yes" button
9. POST /api/v1/events/:id/send-decline-email    → "No" button
```
