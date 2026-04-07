# Backend + Frontend MVP Status (Current)

_Last updated: 2026-03-15_

This document is intentionally **MVP-only** and reflects what is implemented **so far** against [mvp-backend.md](mvp-backend.md).

---

## 1) MVP Scope Reference

### In scope (MVP)

- Google auth + secure token lifecycle
- Google Calendar event import/sync and ongoing updates
- Event storage with Flutter-required fields
- Event APIs for Flutter (upcoming list + detail)
- Attendance response persistence for Yes/No handling
- Email template management (custom + default behavior)
- Decline email sending endpoint
- Sent-email logs

### Out of scope (for current MVP)

- Microsoft/Outlook
- AI email generation
- Workflow expansion/conflict engine enhancements beyond MVP path
- Frontend notification scheduling/travel-time computation owned by backend

---

## 2) Backend MVP Status (Till Now)

## 2.1 Completed

### A) Google auth + token storage/refresh

- Implemented in [src/routes/auth.routes.ts](src/routes/auth.routes.ts) and [src/services/auth.service.ts](src/services/auth.service.ts).
- OAuth callback stores encrypted Google tokens and returns connection status.
- `/api/v1/auth/me` exposes connected-account status.

### B) Calendar sync lifecycle

- Manual sync endpoint: `POST /api/v1/calendar/sync?provider=google`
- Webhook endpoint: `POST /api/v1/calendar/webhook/google`
- Watch creation endpoint: `POST /api/v1/calendar/watch/google`
- OAuth callback triggers initial sync and attempts watch channel creation.
- Watch renewal scheduling/stale-safe behavior is implemented in calendar watch services/workers.

### C) Event model aligned to MVP fields

Implemented event fields now include MVP-critical data:

- title
- description
- start/end time
- timezone
- location
- organizer
- attendees
- provider external event id (Google id)
- status
- cancelled state

Relevant files:

- [src/db/migrations/023_events_mvp_fields.sql](src/db/migrations/023_events_mvp_fields.sql)
- [src/services/calendar/normalizer.ts](src/services/calendar/normalizer.ts)
- [src/services/events.service.ts](src/services/events.service.ts)
- [src/types/index.ts](src/types/index.ts)

### D) Flutter-focused event APIs

- `GET /api/v1/events`
  - upcoming events, chronologically sorted
  - Flutter-friendly list shape
- `GET /api/v1/events/:id`
  - full event detail shape for Flutter

Relevant file: [src/routes/events.routes.ts](src/routes/events.routes.ts)

### E) Email templates MVP

- Implemented route group: `/api/v1/email-templates`
- Supports custom template create/edit/delete and set-default.
- System default is always available and immutable:
  - reserved id: `system-default`
  - cannot edit/delete
  - can be set as active default
- Effective template resolver endpoint:
  - `GET /api/v1/email-templates/effective-default`

Relevant files:

- [src/db/migrations/024_email_templates.sql](src/db/migrations/024_email_templates.sql)
- [src/services/email/templates.service.ts](src/services/email/templates.service.ts)
- [src/routes/emailTemplates.routes.ts](src/routes/emailTemplates.routes.ts)

## 2.2 Latest MVP backend additions

### F) Direct decline-email send endpoint

Completed.

- Endpoint implemented: `POST /api/v1/events/:id/send-decline-email`
- Request supports:
  - `templateId` (optional, including `system-default`)
  - `customSubject` (optional)
  - `customBody` (optional)
  - `sendToOrganizer` (optional, default `true`)
  - `sendToAttendees` (optional, default `true`)
- Backend behavior implemented:
  - loads event context from DB
  - resolves recipients from organizer/attendees
  - excludes authenticated user email from recipients
  - resolves selected template or effective default fallback
  - renders final subject/body with event placeholders
  - sends through Gmail (draft + send path)
  - after successful send, automatically records attendance response as `no`
  - does not mutate or remove the event row after send (event remains in calendar/event APIs)
  - returns stable send payload including message/thread IDs and recipients

Relevant files:

- [src/routes/events.routes.ts](src/routes/events.routes.ts)
- [src/services/email/declineEmail.service.ts](src/services/email/declineEmail.service.ts)
- [src/services/email/gmail.service.ts](src/services/email/gmail.service.ts)

### G) Explicit sent-email log model

Completed.

- New table and migration: `email_send_logs`
- Writes on success and failure are now performed in decline-send flow
- Query endpoint supports product-facing history retrieval

Relevant files:

- [src/db/migrations/025_email_send_logs.sql](src/db/migrations/025_email_send_logs.sql)
- [src/services/email/sendLogs.service.ts](src/services/email/sendLogs.service.ts)
- [src/services/email/declineEmail.service.ts](src/services/email/declineEmail.service.ts)
- [src/routes/events.routes.ts](src/routes/events.routes.ts)

### H) Attendance response endpoint for Yes/No

Completed.

- Endpoint implemented: `POST /api/v1/events/:id/attendance-response`
- Request supports:
  - `response`: `yes` or `no`
- Backend behavior implemented:
  - validates event ownership
  - upserts per-user per-event attendance response
  - stores `handledAt` timestamp for prompt suppression logic

Relevant files:

- [src/db/migrations/027_attendance_responses.sql](src/db/migrations/027_attendance_responses.sql)
- [src/services/attendanceResponses.service.ts](src/services/attendanceResponses.service.ts)
- [src/routes/events.routes.ts](src/routes/events.routes.ts)

---

## 3) Current Backend MVP API Surface

Mounted route groups in [src/app.ts](src/app.ts):

- `/api/v1/auth`
- `/api/v1/calendar`
- `/api/v1/events`
- `/api/v1/email-templates`

This is the current MVP runtime surface.

---

## 4) Frontend MVP (Flutter) — Current Contract

This section is the **Flutter implementation guide** based on current backend behavior.

## 4.1 Implemented backend APIs Flutter can use now

### Auth / account connection

- Start Google connect flow via `/api/v1/auth/google` (with auth token)
- Read account state via `GET /api/v1/auth/me`

### Events

- `GET /api/v1/events` for upcoming event list screen
- `GET /api/v1/events/:id` for event detail screen
- `POST /api/v1/events/:id/attendance-response` for Yes/No action persistence
- `POST /api/v1/events/:id/send-decline-email` for “No” action send flow
- `GET /api/v1/events/:id/decline-email-logs` for per-event send history

### Templates

- `GET /api/v1/email-templates` for templates screen
- `GET /api/v1/email-templates/effective-default` for current effective decline template
- `POST /api/v1/email-templates` create custom template
- `PATCH /api/v1/email-templates/:id` edit custom template
- `DELETE /api/v1/email-templates/:id` delete custom template
- `POST /api/v1/email-templates/:id/set-default` set active default

## 4.2 Flutter MVP behavior rules

- Treat template id `system-default` as read-only in UI.
- Show edit/delete only for custom templates.
- Allow selecting `system-default` or a custom template as default.
- For prefill of decline content, use `GET /effective-default` response directly.
- For event list, consume only `GET /events` and navigate to `GET /events/:id` for details.
- Use `POST /events/:id/attendance-response` for both Yes and No to persist user intent.
- Treat non-null `attendanceResponse` in event payload as already handled for prompt UX.

## 4.3 Flutter integration flow (step-by-step)

### Step 1 — App startup / auth state

1. Get Supabase session on Flutter side.
2. Send backend calls with `Authorization: Bearer <JWT>`.
3. Call `GET /api/v1/auth/me`:

- if Google is connected, proceed to events.
- if not connected, show Connect Google CTA.

### Step 2 — Events list screen

1. Call `GET /api/v1/events`.
2. For each event card, use:

- time/date fields from API
- `attendanceResponse` to determine if prompt is already handled.

3. If `attendanceResponse` is non-null, do not re-show attendance prompt for that event.

### Step 3 — Event detail screen

1. Call `GET /api/v1/events/:id`.
2. Use full payload for attendees, organizer, and event metadata.
3. Use `attendanceResponse` and `attendanceHandledAt` for prompt state and UI badges.

### Step 4 — Yes button behavior

1. Call `POST /api/v1/events/:id/attendance-response` with:

- `{ "response": "yes" }`

2. On success:

- mark event as handled in local state
- close/dismiss attendance prompt
- do not call decline-send endpoint.

### Step 5 — No button behavior

1. Call `POST /api/v1/events/:id/send-decline-email` (single call for No flow send).
2. On success:

- backend sends Gmail decline message
- backend writes send log
- backend automatically writes `attendanceResponse = "no"`
- event remains in list/detail APIs (not removed).

3. Optional UI refresh:

- refresh event detail/list to reflect attendance response
- optionally call logs endpoint to show send history.

### Step 6 — Send history UI (optional but recommended)

1. Call `GET /api/v1/events/:id/decline-email-logs`.
2. Show latest status chips from log entries:

- `sent`
- `already_sent`
- `failed`.

## 4.4 API response handling rules (Flutter)

- `200` on GET routes: render data directly.
- `200` on attendance-response: set local prompt state to handled.
- `200` on send-decline-email: show success toast and mark attendance as `no` in UI state.
- `400`: show validation error from `error` field.
- `401`: session invalid/expired; force re-auth.
- `404`: event missing; pop detail screen and refresh list.
- `5xx`: show retry CTA and keep user on current screen.

## 4.5 Minimal client-side state model

Per event, keep:

- `attendanceResponse`: `null | yes | no`
- `attendanceHandledAt`: timestamp or null
- `declineSendStatus`: `idle | sending | sent | failed`
- `declineLastError`: nullable string.

This is enough for MVP to avoid duplicate prompt behavior and support clear UX feedback.

## 4.6 Frontend MVP pieces still blocked by pending backend work

No backend Phase 6/7 blocker remains for MVP send flow.

Blocked frontend flow parts:

- none from backend Phase 6/7; remaining work is Phase 8 docs/testing stabilization

---

## 5) Next MVP Milestones (Strict)

1. Wire Flutter startup + auth/me + connect CTA flow.
2. Wire event list/detail with `attendanceResponse`-aware prompt behavior.
3. Wire Yes (`attendance-response`) and No (`send-decline-email`) with retry-safe UI states.
4. Add send-history UI via decline-email logs.
5. Final MVP validation pass (attendance + decline E2E).

---

## 6) One-Line Current State

Backend MVP is complete through **auth + sync + events + attendance response persistence + template management + direct decline send + explicit send logs**; remaining work is **Flutter wiring + final E2E validation**.
