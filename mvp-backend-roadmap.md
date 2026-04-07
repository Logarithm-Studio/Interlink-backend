# Interlink Backend MVP Roadmap

This roadmap is based on the **current backend implementation** and the target backend scope defined in [mvp-backend.md](mvp-backend.md).

It is written to be followed **serially**, one phase at a time, until the backend MVP is complete.

Current execution status (2026-03-13):

- ✅ Phase 1 complete
- ✅ Phase 2 complete
- ✅ Phase 3 complete
- ✅ Phase 4 complete
- ✅ Phase 5 complete
- ✅ Phase 6 complete
- ✅ Phase 7 complete
- ✅ Phase 8 complete

---

## 1. Roadmap Goal

Deliver a backend that is the source of truth for:

- Google account connection and token lifecycle
- Google Calendar event storage and synchronization
- Event APIs for Flutter
- User decline email templates
- Gmail sending for decline flow
- Send logs / audit trail

This roadmap intentionally **de-prioritizes** workflow/conflict/AI-heavy paths that are already in the codebase but are not required for the MVP backend defined in [mvp-backend.md](mvp-backend.md).

---

## 2. Current Status Summary

### 2.1 Already implemented and reusable

These backend pieces already exist and should be **kept and reused**:

1. **Google auth and token refresh**
   - [src/routes/auth.routes.ts](src/routes/auth.routes.ts)
   - [src/services/auth.service.ts](src/services/auth.service.ts)
   - [src/security/crypto.ts](src/security/crypto.ts)
   - [src/security/keyring.ts](src/security/keyring.ts)

2. **Calendar sync foundation**
   - [src/routes/calendar.routes.ts](src/routes/calendar.routes.ts)
   - [src/services/calendar/google.ts](src/services/calendar/google.ts)
   - [src/services/calendar/sync.ts](src/services/calendar/sync.ts)
   - [src/services/calendar/googleWatch.service.ts](src/services/calendar/googleWatch.service.ts)
   - [src/services/calendar/googleSyncCursor.service.ts](src/services/calendar/googleSyncCursor.service.ts)
   - [src/workers/processors/calendarSync.processor.ts](src/workers/processors/calendarSync.processor.ts)

3. **Events persistence and API base**
   - [src/services/events.service.ts](src/services/events.service.ts)
   - [src/routes/events.routes.ts](src/routes/events.routes.ts)
   - [src/services/calendar/normalizer.ts](src/services/calendar/normalizer.ts)

4. **Gmail integration core**
   - [src/services/email/gmail.service.ts](src/services/email/gmail.service.ts)
   - [src/services/email/email.service.ts](src/services/email/email.service.ts)

5. **Audit / idempotency / rate-limit foundation**
   - [src/security/idempotency.ts](src/security/idempotency.ts)
   - [src/services/audit.service.ts](src/services/audit.service.ts)
   - [src/middleware/rateLimit.ts](src/middleware/rateLimit.ts)

### 2.2 Implemented, but needs modification for MVP

These pieces exist, but the backend MVP needs them simplified or adjusted:

1. **Events schema / event payload shape**
   - current model is close, but needs explicit support for:
     - timezone
     - location
     - organizer
     - attendees
     - Google event id
     - event status / cancelled state

2. **Events API shape for Flutter**
   - current routes include extra conflict-related operations
   - need cleaner MVP endpoints focused on:
     - upcoming events list
     - single event details
     - organizer + attendee emails
     - location
     - event status

3. **Watch renewal flow**
   - renewal logic exists but needs actual scheduling/orchestration

4. **Gmail send flow**
   - services exist, but MVP needs a direct backend endpoint for sending decline emails

5. **Send logging**
   - current logging exists, but MVP needs an explicit sent-email record structure

### 2.3 Not implemented yet

All originally listed MVP items are implemented.

Remaining work is post-MVP evolution only (new features, optimization, or expanded provider coverage).

---

## 3. Scope Rules for This Backend MVP

### 3.1 In scope

- Google only
- Gmail only
- Events as source of truth in DB
- Manual sync + webhook/incremental sync
- Event read APIs for Flutter
- Email template CRUD
- Direct decline-email send endpoint
- Send logs

### 3.2 Out of scope for now

Do **not** spend time on these before MVP completion:

- Microsoft Graph integration
- Outlook email integration
- AI email generation
- Conflict engine enhancements
- Workflow engine expansion
- Push notification product logic
- Travel time calculation
- Notification scheduling
- Flutter UI concerns

These can remain in the repo, but they are **not on the critical path** for backend MVP completion.

---

## 4. Serial Execution Plan

Follow these phases in order.

---

## Phase 1 — Freeze and simplify the backend surface

### Goal

Make the backend clearly aligned to the MVP and reduce confusion from extra systems.

### Tasks

1. Review all current routes and identify which are MVP-critical.
2. Keep these route groups active:
   - auth
   - calendar
   - events
3. Plan new route group(s):
   - email templates
   - email send / decline email
4. Mark these as non-MVP / low priority:
   - conflicts
   - workflows
   - workflow actions
   - AI-driven email preview flow

### Expected output

A clear backend surface area with a known MVP path and no ambiguity about what to build next.

### Files to inspect/update

- [src/app.ts](src/app.ts)
- [src/routes/events.routes.ts](src/routes/events.routes.ts)
- [src/routes/calendar.routes.ts](src/routes/calendar.routes.ts)

### Phase completion criteria

- MVP route surface is defined.
- Non-MVP systems are explicitly deprioritized.

---

## Phase 2 — Fix the event model to match backend-mvp.md

### Goal

Ensure the DB and normalized event model match the event data Flutter needs.

### Required event fields

The stored event model must cleanly expose:

- title
- description
- start time
- end time
- timezone
- location
- organizer
- attendees
- Google event id
- status / cancelled state

### Tasks

1. Inspect current `events` schema.
2. Add migration(s) to extend events table if needed.
3. Update the normalizer to extract and persist:
   - timezone
   - location
   - status
   - cancelled state
4. Update TypeScript event types.
5. Update persistence mapping and row-to-model mapping.

### Likely files

- [src/db/migrations/003_events.sql](src/db/migrations/003_events.sql)
- new migration under [src/db/migrations](src/db/migrations)
- [src/services/calendar/normalizer.ts](src/services/calendar/normalizer.ts)
- [src/services/events.service.ts](src/services/events.service.ts)
- [src/types/index.ts](src/types/index.ts)

### Phase completion criteria

- Event rows contain all MVP-required fields.
- Sync path preserves those fields correctly.
- Event API can expose those fields directly.

---

## Phase 3 — Clean event APIs for Flutter

### Goal

Provide a simple, stable event API surface for Flutter.

### Required endpoints

1. **Upcoming events list**
   - sorted chronologically
   - returns enough summary data for list UI

2. **Single event details**
   - full detail for one event
   - organizer email
   - attendee emails
   - location
   - status

### Tasks

1. Keep `GET /events` but shape response around upcoming events.
2. Keep `GET /events/:id` and ensure detail completeness.
3. Remove dependency on conflict-specific response shape.
4. Ensure response fields are Flutter-friendly and consistent.

### Likely files

- [src/routes/events.routes.ts](src/routes/events.routes.ts)
- [src/services/events.service.ts](src/services/events.service.ts)

### Phase completion criteria

- Flutter can fetch upcoming events cleanly.
- Flutter can fetch full single-event details cleanly.
- Event response shape matches backend MVP requirements.

---

## Phase 4 — Finalize calendar sync lifecycle

### Goal

Complete the sync behavior so calendar state stays correct after first connect.

### Required behavior

- initial import on first connect
- incremental sync after first import
- create/update/delete handling
- watch/webhook support
- watch renewal support

### Tasks

1. Confirm first-connect sync is triggered reliably.
2. Keep manual sync endpoint for testing.
3. Verify incremental sync handles cancelled/deleted events correctly.
4. Add scheduling path for Google watch renewal jobs.
5. Ensure stale/expired sync token recovery remains correct.

### Likely files

- [src/routes/auth.routes.ts](src/routes/auth.routes.ts)
- [src/routes/calendar.routes.ts](src/routes/calendar.routes.ts)
- [src/services/calendar/sync.ts](src/services/calendar/sync.ts)
- [src/services/calendar/googleWatch.service.ts](src/services/calendar/googleWatch.service.ts)
- [src/workers/processors/calendarSync.processor.ts](src/workers/processors/calendarSync.processor.ts)
- [src/queues/queues.ts](src/queues/queues.ts)

### Phase completion criteria

- First import works.
- Incremental sync updates local DB correctly.
- Deleted/cancelled events are reflected locally.
- Watch channels are renewed before expiry.

---

## Phase 5 — Build email template management

### Goal

Add per-user custom decline email templates, including one active default.

### Required functionality

- create template
- edit template
- delete template
- list templates
- mark one as active default
- use system default if no custom template is active

### Suggested data model

`email_templates`

- id
- user_id
- name
- subject_template
- body_template
- is_active_default
- created_at
- updated_at

### Tasks

1. Create DB migration for templates.
2. Add service layer for template CRUD.
3. Add routes for template management.
4. Enforce one active default per user.
5. Add fallback system default in service layer.

### Likely new files

- new migration under [src/db/migrations](src/db/migrations)
- [src/routes/emailTemplates.routes.ts](src/routes/emailTemplates.routes.ts)
- [src/services/email/templates.service.ts](src/services/email/templates.service.ts)

### Existing files to update

- [src/app.ts](src/app.ts)

### Phase completion criteria

- Users can create and manage custom decline templates.
- One default template can be selected.
- System fallback works when no custom default exists.

---

## Phase 6 — Build direct decline-email send flow

### Goal

Provide a backend endpoint that Flutter can call when user selects **No**.

### Required behavior

When user presses **No**, backend should:

1. load event info
2. load organizer + attendee recipients
3. load selected custom template or fallback default template
4. render final subject/body
5. send through Gmail API
6. save send result/log

### API shape to add

Suggested endpoint:

- `POST /api/v1/events/:id/send-decline-email`

Suggested request body:

- `templateId` (optional)
- `customSubject` (optional)
- `customBody` (optional)
- `sendToOrganizer` (default true)
- `sendToAttendees` (default true)

### Tasks

1. Add rendering logic for chosen template.
2. Resolve recipients from event record.
3. Call existing Gmail send service.
4. Handle Gmail auth failures cleanly.
5. Return sent status and message ID.

### Likely files

- new route file or extend [src/routes/events.routes.ts](src/routes/events.routes.ts)
- new service: [src/services/email/declineEmail.service.ts](src/services/email/declineEmail.service.ts)
- [src/services/email/email.service.ts](src/services/email/email.service.ts)
- [src/services/email/gmail.service.ts](src/services/email/gmail.service.ts)

### Phase completion criteria

- Flutter can trigger decline-email sending with one backend call.
- Backend chooses template/fallback correctly.
- Gmail send succeeds and returns a stable result payload.

---

## Phase 7 — Add explicit send logs

### Goal

Store clear records of what was sent for each decline-email action.

### Required log fields

- event id
- recipients
- subject
- body
- status
- Gmail message id
- failure reason

### Suggested data model

`email_send_logs`

- id
- user_id
- event_id
- template_id (nullable)
- recipients (jsonb)
- subject
- body
- status
- gmail_message_id
- failure_reason
- created_at

### Tasks

1. Add migration for send logs.
2. Save log row on success and failure.
3. Link sent email to event and user.
4. Keep audit log writes too, but use send log as the main product-facing record.

### Likely files

- new migration under [src/db/migrations](src/db/migrations)
- new service or extend decline email service
- [src/services/audit.service.ts](src/services/audit.service.ts)

### Phase completion criteria

- Every send attempt is recorded.
- Success/failure can be queried later.
- Product-facing send history is explicit and understandable.

---

## Phase 8 — Validation and cleanup

### Goal

Ensure the backend MVP is complete, testable, and easy for Flutter integration.

### Tasks

1. Update manual testing docs.
2. Add curl examples for:
   - connect Google
   - sync calendar
   - list events
   - get event detail
   - manage templates
   - send decline email
3. Remove ambiguity in docs about backend vs Flutter responsibilities.
4. Verify non-MVP systems do not block MVP use.

### Files likely to update

- [mvp-backend.md](mvp-backend.md)
- [backend-documentation.md](backend-documentation.md)
- [TESTING.md](TESTING.md)
- [mvp-testing-guide.md](mvp-testing-guide.md)

### Phase completion criteria

- Flutter developer has stable backend contracts.
- Backend MVP can be tested end-to-end manually.
- Documentation matches implementation.

---

## 5. Priority Order Summary

Follow this exact order:

1. **Phase 1** — Freeze MVP backend surface
2. **Phase 2** — Fix event model
3. **Phase 3** — Clean event APIs
4. **Phase 4** — Finalize calendar sync lifecycle
5. **Phase 5** — Build email templates CRUD
6. **Phase 6** — Build decline-email send endpoint
7. **Phase 7** — Add explicit send logs
8. **Phase 8** — Validate and document

---

## 6. Definition of Done

Backend MVP is complete when all of the following are true:

1. User can connect Google account.
2. Tokens are securely stored and refreshed.
3. Initial calendar import works.
4. Incremental sync updates events correctly.
5. Events API returns upcoming events and full event detail.
6. Event records include organizer, attendees, location, status, timezone, and Google event id.
7. User can create/edit/delete decline templates.
8. User can set one active default template.
9. Flutter can call one endpoint to send a decline email for an event.
10. Sent email attempts are logged clearly.
11. Backend docs and test flow are updated.

---

## 7. Keep / Modify / Ignore Guide

### Keep

- Google auth/token system
- encrypted token storage
- Google sync implementation
- watch/webhook infrastructure
- Gmail service core
- audit/idempotency utilities

### Modify

- event schema and event APIs
- watch renewal orchestration
- email service usage pattern
- logging model for sent mail

### Ignore for now

- workflows
- conflict engine
- AI email generation
- push notification product flow
- Microsoft integration

---

## 8. Immediate Start Point

MVP roadmap execution is complete.

If continuing development, use this order:

1. post-MVP hardening and observability
2. provider expansion (Microsoft/Outlook)
3. optional workflow/conflict/AI enhancements
