# Interlink MVP Testing Guide (Postman-Ready cURL)

This version is formatted so each command can be copied and pasted directly into Postman (`Import` -> `Raw text`).

## How to use this in Postman

1. Copy one curl block.
2. In Postman, click `Import` -> `Raw text` -> paste -> `Continue` -> `Import`.
3. Replace placeholders in the imported request:
   - `<JWT>`

- `<SUPABASE_URL>`
- `<SUPABASE_ANON_KEY>`
- `<TEST_EMAIL>`
- `<TEST_PASSWORD>`
- `<EVENT_ID>`
- `<TEMPLATE_ID>`
- `<CHANNEL_ID>`
- `<RESOURCE_ID>`
- `<CHANNEL_TOKEN>`

All commands use `http://localhost:5000` directly (no shell variables).

## Flutter Integration Quickstart (MVP)

Use this as the practical implementation order in Flutter:

1. Auth bootstrap

- get Supabase session token
- call `GET /api/v1/auth/me`
- if not connected, show Google connect CTA

2. Event list

- call `GET /api/v1/events`
- for each event, use `attendanceResponse` to decide if prompt is already handled

3. Event detail

- call `GET /api/v1/events/:id`
- use `attendanceResponse` and `attendanceHandledAt` for UI state

4. Yes button

- call `POST /api/v1/events/:id/attendance-response` with `{ "response": "yes" }`
- close/dismiss prompt on success

5. No button

- call `POST /api/v1/events/:id/send-decline-email`
- backend auto-records attendance response as `no` after successful send
- optional: call logs endpoint to show delivery history

Recommended UI handling by status code:

- `200`: update local UI state immediately
- `400`: show validation error message from response
- `401`: force re-auth/login
- `404`: event not found; refresh list and close detail view
- `5xx`: show retry CTA

## 0) Supabase User Registration + Login (Get JWT)

Use this first if you do not already have a valid `<JWT>`.

## 0.1 Register a user in Supabase Auth

```bash
curl --location --request POST '<SUPABASE_URL>/auth/v1/signup' \
--header 'apikey: <SUPABASE_ANON_KEY>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "email": "<TEST_EMAIL>",
  "password": "<TEST_PASSWORD>"
}'
```

Note: if email confirmation is enabled, confirm the user before password login.

## 0.2 Sign in and get access token (JWT)

```bash
curl --location --request POST '<SUPABASE_URL>/auth/v1/token?grant_type=password' \
--header 'apikey: <SUPABASE_ANON_KEY>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "email": "<TEST_EMAIL>",
  "password": "<TEST_PASSWORD>"
}'
```

From response, copy `access_token` and use it as `<JWT>` in all backend API calls.

## 1) Health

```bash
curl --location --request GET 'http://localhost:5000/health'
```

## 2) Auth + Google Connect

## 2.1 Check current user/account

```bash
curl --location --request GET 'http://localhost:5000/api/v1/auth/me' \
--header 'Authorization: Bearer <JWT>'
```

## 2.2 Start Google OAuth (returns redirect)

```bash
curl --location --request GET 'http://localhost:5000/api/v1/auth/google' \
--header 'Authorization: Bearer <JWT>'
```

Note: complete Google consent in browser; callback endpoint is browser-driven.

## 2.3 Verify Google account connected

```bash
curl --location --request GET 'http://localhost:5000/api/v1/auth/me' \
--header 'Authorization: Bearer <JWT>'
```

## 3) Calendar Sync + Watch + Webhook

## 3.1 Manual sync

```bash
curl --location --request POST 'http://localhost:5000/api/v1/calendar/sync?provider=google' \
--header 'Authorization: Bearer <JWT>'
```

## 3.2 Create watch channel

```bash
curl --location --request POST 'http://localhost:5000/api/v1/calendar/watch/google' \
--header 'Authorization: Bearer <JWT>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "calendarId": "primary"
}'
```

## 3.3 Simulate webhook notification

```bash
curl --location --request POST 'http://localhost:5000/api/v1/calendar/webhook/google' \
--header 'x-goog-channel-id: <CHANNEL_ID>' \
--header 'x-goog-resource-id: <RESOURCE_ID>' \
--header 'x-goog-resource-state: exists' \
--header 'x-goog-message-number: 1001' \
--header 'x-goog-channel-token: <CHANNEL_TOKEN>'
```

## 4) Events

## 4.1 List upcoming events

```bash
curl --location --request GET 'http://localhost:5000/api/v1/events' \
--header 'Authorization: Bearer <JWT>'
```

## 4.2 List events with date filter

```bash
curl --location --request GET 'http://localhost:5000/api/v1/events?from=2026-03-01T00:00:00.000Z&to=2026-03-31T23:59:59.999Z' \
--header 'Authorization: Bearer <JWT>'
```

## 4.3 Event detail

```bash
curl --location --request GET 'http://localhost:5000/api/v1/events/<EVENT_ID>' \
--header 'Authorization: Bearer <JWT>'
```

## 4.4 Record attendance response: Yes

```bash
curl --location --request POST 'http://localhost:5000/api/v1/events/<EVENT_ID>/attendance-response' \
--header 'Authorization: Bearer <JWT>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "response": "yes"
}'
```

## 4.5 Record attendance response: No

```bash
curl --location --request POST 'http://localhost:5000/api/v1/events/<EVENT_ID>/attendance-response' \
--header 'Authorization: Bearer <JWT>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "response": "no"
}'
```

Use this endpoint for both Yes and No button handling so prompt decisions are persisted.

## 5) Email Templates

## 5.1 List templates

```bash
curl --location --request GET 'http://localhost:5000/api/v1/email-templates' \
--header 'Authorization: Bearer <JWT>'
```

## 5.2 Get effective default template

```bash
curl --location --request GET 'http://localhost:5000/api/v1/email-templates/effective-default' \
--header 'Authorization: Bearer <JWT>'
```

## 5.3 Create custom template

```bash
curl --location --request POST 'http://localhost:5000/api/v1/email-templates' \
--header 'Authorization: Bearer <JWT>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "name": "MVP Decline Template",
  "subjectTemplate": "Unable to attend: {{eventTitle}}",
  "bodyTemplate": "Hi, I will not be able to attend {{eventTitle}} at {{eventStart}}.",
  "isActiveDefault": true
}'
```

## 5.4 Update custom template

```bash
curl --location --request PATCH 'http://localhost:5000/api/v1/email-templates/<TEMPLATE_ID>' \
--header 'Authorization: Bearer <JWT>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "name": "MVP Decline Template v2",
  "bodyTemplate": "Hello, I am unable to attend {{eventTitle}}. Sorry for the inconvenience."
}'
```

## 5.5 Set custom template as default

```bash
curl --location --request POST 'http://localhost:5000/api/v1/email-templates/<TEMPLATE_ID>/set-default' \
--header 'Authorization: Bearer <JWT>'
```

## 5.6 Set system default as active

```bash
curl --location --request POST 'http://localhost:5000/api/v1/email-templates/system-default/set-default' \
--header 'Authorization: Bearer <JWT>'
```

## 5.7 Delete custom template

```bash
curl --location --request DELETE 'http://localhost:5000/api/v1/email-templates/<TEMPLATE_ID>' \
--header 'Authorization: Bearer <JWT>'
```

## 6) Decline Email Send + Logs

Important: On successful send (`sent` or `already_sent`), backend records explicit send logs and does not remove the event row.
Also on successful send, backend automatically persists attendance response as `no` for that event.

## 6.1 Send decline using effective default template

```bash
curl --location --request POST 'http://localhost:5000/api/v1/events/<EVENT_ID>/send-decline-email' \
--header 'Authorization: Bearer <JWT>' \
--header 'Content-Type: application/json' \
--data-raw '{}'
```

## 6.2 Send decline with explicit template + recipient toggles

```bash
curl --location --request POST 'http://localhost:5000/api/v1/events/<EVENT_ID>/send-decline-email' \
--header 'Authorization: Bearer <JWT>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "templateId": "system-default",
  "sendToOrganizer": true,
  "sendToAttendees": true
}'
```

## 6.3 Send decline with custom subject/body

```bash
curl --location --request POST 'http://localhost:5000/api/v1/events/<EVENT_ID>/send-decline-email' \
--header 'Authorization: Bearer <JWT>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "customSubject": "Unable to attend",
  "customBody": "Hi, I am unable to attend this meeting. Thank you."
}'
```

## 6.4 Read decline email logs

```bash
curl --location --request GET 'http://localhost:5000/api/v1/events/<EVENT_ID>/decline-email-logs' \
--header 'Authorization: Bearer <JWT>'
```

## 7) Required Negative Tests

## 7.1 Missing JWT

```bash
curl --location --request GET 'http://localhost:5000/api/v1/events'
```

## 7.2 Unsupported sync provider

```bash
curl --location --request POST 'http://localhost:5000/api/v1/calendar/sync?provider=microsoft' \
--header 'Authorization: Bearer <JWT>'
```

## 7.3 Event not found

```bash
curl --location --request GET 'http://localhost:5000/api/v1/events/00000000-0000-0000-0000-000000000000' \
--header 'Authorization: Bearer <JWT>'
```

## 7.4 Edit system-default template (must fail)

```bash
curl --location --request PATCH 'http://localhost:5000/api/v1/email-templates/system-default' \
--header 'Authorization: Bearer <JWT>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "name": "should-fail"
}'
```

## 7.5 Delete system-default template (must fail)

```bash
curl --location --request DELETE 'http://localhost:5000/api/v1/email-templates/system-default' \
--header 'Authorization: Bearer <JWT>'
```

## 7.6 Decline send validation error (empty subject)

```bash
curl --location --request POST 'http://localhost:5000/api/v1/events/<EVENT_ID>/send-decline-email' \
--header 'Authorization: Bearer <JWT>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "customSubject": ""
}'
```

## 7.7 Attendance response validation error (invalid value)

```bash
curl --location --request POST 'http://localhost:5000/api/v1/events/<EVENT_ID>/attendance-response' \
--header 'Authorization: Bearer <JWT>' \
--header 'Content-Type: application/json' \
--data-raw '{
  "response": "maybe"
}'
```

## 8) MVP Pass Criteria

MVP backend is fully verified when all these pass:

1. Google account can be connected and remains available via `/api/v1/auth/me`.
2. Calendar manual sync works.
3. Watch channel creation + webhook acceptance work.
4. Events list/detail APIs return correct data.
5. Attendance response endpoint accepts `yes`/`no` and stores handled state.
6. Template CRUD works, and `system-default` immutability is enforced.
7. Decline send works with default/template/custom paths.
8. Successful decline send keeps event data intact and still records send status.
9. Decline send logs return explicit history (`sent`, `already_sent`, `failed`).
