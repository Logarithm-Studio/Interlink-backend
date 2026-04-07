# Backend MVP Contract (Flutter)

This is the finalized backend MVP contract for the Flutter app.

## 1) Backend responsibilities (MVP)

### 1.1 Google auth + token lifecycle

- Connect user Google account
- Store OAuth tokens encrypted
- Refresh access tokens automatically
- Surface reconnect-required auth failures cleanly

### 1.2 Calendar sync lifecycle

- Trigger first import after Google connect
- Support manual sync for testing: `POST /api/v1/calendar/sync?provider=google`
- Support webhook-driven incremental updates
- Support Google watch creation and renewal

### 1.3 Event source of truth

Events stored in backend DB expose:

- `title`, `description`
- `startTime`, `endTime`
- `timezone`, `location`
- `organizerEmail`, `attendees`
- provider external event id
- `status`, `isCancelled`

### 1.4 Event APIs for Flutter

- `GET /api/v1/events` (upcoming list)
- `GET /api/v1/events/:id` (single event detail)

### 1.5 Decline template management

- `GET /api/v1/email-templates`
- `GET /api/v1/email-templates/effective-default`
- `POST /api/v1/email-templates`
- `PATCH /api/v1/email-templates/:id`
- `DELETE /api/v1/email-templates/:id`
- `POST /api/v1/email-templates/:id/set-default`

System default template behavior:

- reserved id: `system-default`
- always present in templates list
- cannot be edited/deleted
- can be selected as active default

### 1.6 Decline email send + logs

When Flutter user selects **No**, backend provides one-call send flow:

- `POST /api/v1/events/:id/send-decline-email`

Backend behavior:

1. load event
2. resolve recipients from organizer/attendees
3. exclude authenticated user email
4. resolve selected template or effective default fallback
5. render final subject/body
6. send via Gmail
7. persist explicit send log

Send log history endpoint:

- `GET /api/v1/events/:id/decline-email-logs`

---

## 2) Flutter responsibilities (MVP)

Flutter owns:

- UI screens/flows (list, detail, templates, decline send)
- user actions (Yes/No decisions)
- local permissions and UX
- API calls to backend contracts above

Flutter does **not** own:

- Google OAuth token refresh logic
- event source-of-truth storage
- Gmail send execution
- server-side send logging

---

## 3) Out of scope for this MVP

- Microsoft/Outlook integration
- AI email generation as required path
- Workflow/conflict engine as product-critical path
- travel-time engine / notification scheduling

---

## 4) MVP completion checklist

MVP backend is done when all are true:

1. Google connect works and token lifecycle is stable.
2. Initial + incremental calendar sync keeps DB events current.
3. Flutter can read upcoming events and event detail.
4. Flutter can manage custom templates with immutable system default behavior.
5. Flutter can trigger decline send with one API call.
6. Every send attempt is logged and queryable by event.
7. Manual testing and curl docs match these contracts.
