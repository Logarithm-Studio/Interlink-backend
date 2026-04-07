# Interlink MVP Goal (Final)

This document is the final MVP goal aligned to current implementation and contracts.

## 1) Product Goal

Build a Flutter app + backend flow where users connect Google Calendar, view upcoming events, and send decline emails quickly with template support when they cannot attend.

---

## 2) MVP Scope (In)

### Backend

- Google OAuth connect + encrypted token storage + refresh lifecycle
- Initial calendar import after connect
- Manual sync + webhook-driven incremental updates + watch renewal
- Event source of truth with organizer/attendees/location/status fields
- Upcoming event list and event detail APIs
- Decline template management with immutable system default
- One-call decline email send endpoint
- Explicit send logs per event

### Flutter

- Login/connect account flow using backend auth endpoints
- Upcoming event list screen + event detail screen
- Template management UI (custom templates only editable/deletable)
- Decline send flow (`No` action) using single backend send endpoint
- Send history display using decline-email logs endpoint

---

## 3) MVP Scope (Out)

- Microsoft/Outlook integration
- AI email generation as required path
- Workflow/conflict engine as product-critical path
- Travel-time computation and notification scheduling engine

---

## 4) Backend API Contract (MVP)

### Auth + Calendar

- `GET /api/v1/auth/google`
- `GET /api/v1/auth/callback/google`
- `GET /api/v1/auth/me`
- `POST /api/v1/calendar/sync?provider=google`
- `POST /api/v1/calendar/watch/google`
- `POST /api/v1/calendar/webhook/google`

### Events

- `GET /api/v1/events`
- `GET /api/v1/events/:id`
- `POST /api/v1/events/:id/send-decline-email`
- `GET /api/v1/events/:id/decline-email-logs`

### Templates

- `GET /api/v1/email-templates`
- `GET /api/v1/email-templates/effective-default`
- `POST /api/v1/email-templates`
- `PATCH /api/v1/email-templates/:id`
- `DELETE /api/v1/email-templates/:id`
- `POST /api/v1/email-templates/:id/set-default`

System default contract:

- reserved id: `system-default`
- always present
- cannot be edited/deleted
- can be set as active default

---

## 5) Decline Send Behavior (MVP)

When user selects `No`, backend must:

1. load event data
2. resolve recipients from organizer/attendees
3. exclude authenticated user email
4. resolve selected template or fallback effective default
5. render final subject/body
6. send via Gmail
7. persist explicit send log (`sent`, `already_sent`, or `failed`)

---

## 6) Responsibility Split

### Backend owns

- token lifecycle
- sync/event persistence
- template resolution
- Gmail send execution
- send logs persistence/query

### Flutter owns

- UI and user interactions
- calling backend APIs
- presenting template/send-history state

---

## 7) MVP Definition of Done

MVP is complete when:

1. Google account connect and token lifecycle are stable.
2. Initial + incremental sync keep events current.
3. Flutter reads upcoming events and event detail from backend.
4. Template management works with immutable system default behavior.
5. One-call decline send endpoint works end-to-end.
6. Every send attempt is logged and queryable per event.
7. Testing/curl docs match the implemented contracts.
