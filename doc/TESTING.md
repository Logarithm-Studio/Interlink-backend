# Interlink Backend MVP — Manual Testing Guide

This guide validates the current MVP backend only.

## 1) Scope under test

Mounted route groups:

- `/api/v1/auth`
- `/api/v1/calendar`
- `/api/v1/events`
- `/api/v1/email-templates`

Not required for MVP validation:

- workflows/conflicts/AI flows
- push-token and preferences product flows
- Microsoft/Outlook

---

## 2) Prerequisites

## 2.1 Start services

```bash
# Terminal 1
npm run dev

# Terminal 2
npm run worker:dev
```

## 2.2 Apply migrations

```bash
npm run migrate
```

Ensure migration `025_email_send_logs.sql` is applied.

## 2.3 Minimum env requirements

- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_KEY`
- `REDIS_URL`
- `ENCRYPTION_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_WEBHOOK_URL` (required for watch/webhook testing)

## 2.4 Test token

Obtain a valid Supabase JWT and use in all authenticated calls:

```http
Authorization: Bearer <JWT>
```

---

## 3) MVP test checklist

## 3.1 Health

- `GET /health` returns `200` and status `ok`.

## 3.2 Auth + Google connect

- `GET /api/v1/auth/me` returns user and account status.
- `GET /api/v1/auth/google` (with auth header) returns redirect.
- Complete consent in browser.
- Callback returns `initialSyncTriggered: true` and provider `google`.
- Re-check `GET /api/v1/auth/me` shows connected Google account.

## 3.3 Calendar sync lifecycle

- `POST /api/v1/calendar/sync?provider=google` succeeds.
- `POST /api/v1/calendar/watch/google` creates a channel.
- Webhook simulation `POST /api/v1/calendar/webhook/google` returns `200` and enqueues sync.

## 3.4 Events API

- `GET /api/v1/events` returns upcoming events list.
- `GET /api/v1/events/:id` returns detailed event.
- Verify payload includes location, organizer, attendees, status, and cancellation state.

## 3.5 Template management

- `GET /api/v1/email-templates` includes `system-default` entry.
- `PATCH/DELETE /api/v1/email-templates/system-default` return `400`.
- Create custom template (`POST`).
- Update custom template (`PATCH /:id`).
- Set default (`POST /:id/set-default`).
- Effective template (`GET /effective-default`) reflects chosen default.

## 3.6 Decline send + logs

- `POST /api/v1/events/:id/send-decline-email` sends successfully.
- Confirm recipients exclude authenticated user email.
- Confirm response includes `sendLogId`.
- `GET /api/v1/events/:id/decline-email-logs` returns latest send record.
- Trigger a failure path (e.g., revoked Google token) and confirm `failed` log row is created.

---

## 4) Definition of pass (MVP)

All pass conditions below must be true:

1. Google account can be connected and reused.
2. Event sync and event read APIs work for Flutter.
3. Templates work with immutable system default behavior.
4. One-call decline send works through Gmail.
5. Every send attempt is explicitly logged and queryable.

---

## 5) Backend vs Flutter responsibility clarity

Backend owns:

- auth/token lifecycle
- event storage/sync
- template/default resolution
- Gmail send execution
- send logs

Flutter owns:

- UI flow and user actions
- invoking backend APIs
- client-side presentation of event/template/send history
