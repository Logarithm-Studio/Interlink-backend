# Interlink Backend — API Reference & Testing Guide

Canonical, code-accurate reference for the Interlink backend HTTP API. Replaces the old
`mvp-*.md` / `GEMINI.md` docs (which described a Flutter client and a Redis/BullMQ stack that
no longer exist). The real client is the Expo app in `../Interlink-app`; async work runs on
QStash, not Redis — see [CLAUDE.md](CLAUDE.md) for architecture.

Base URL in local dev: `http://localhost:5000`. All routes are under `/api/v1` except `/health`.

## Auth model

Every app-facing route requires `Authorization: Bearer <SUPABASE_JWT>` (validated via
`supabase.auth.getUser`, which upserts the user into the local `users` table). Get a JWT from
Supabase directly:

```bash
# Sign in → copy access_token from the response
curl -X POST '<SUPABASE_URL>/auth/v1/token?grant_type=password' \
  -H 'apikey: <SUPABASE_ANON_KEY>' -H 'Content-Type: application/json' \
  -d '{"email":"<TEST_EMAIL>","password":"<TEST_PASSWORD>"}'
```

`/api/v1/calendar/webhook/google` (Google push) and `/api/v1/workers/*` (QStash callbacks) are
the only non-JWT routes — they authenticate via Google channel headers and the
`Upstash-Signature` header respectively.

## Endpoint map (current, from `src/app.ts` + route files)

### `/api/v1/auth`
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/email/send-code` | Send 4-digit OTP to email (SMTP) |
| POST | `/email/verify-code` | Verify OTP |
| POST | `/signup` | Email/password signup |
| POST | `/login` | Email/password login |
| POST | `/refresh-token` | Refresh session token |
| GET | `/google/start` | Begin Google OAuth (returns redirect) |
| GET | `/google` | Google connect entry |
| GET | `/callback/google` | OAuth callback (browser-driven); triggers initial sync + watch |
| DELETE | `/google` | Disconnect Google account |
| GET | `/me` | Current user + Google connection status |
| PUT | `/profile` | Update user profile fields |

### `/api/v1/calendar`
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/sync?provider=google` | Manual calendar sync |
| POST | `/watch/google` | Create Google watch channel (body `{ "calendarId": "primary" }`) |
| POST | `/webhook/google` | Google push notification receiver (no JWT; Google channel headers) |

### `/api/v1/events`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Upcoming events (optional `?from=&to=` ISO range) |
| GET | `/:id` | Event detail |
| POST | `/:id/attendance-response` | Persist Yes/No (`{ "response": "yes" \| "no" }`) |
| POST | `/:id/send-decline-email` | One-call decline send (see below) |
| GET | `/:id/decline-email-logs` | Per-event send history |

### `/api/v1/email-templates`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | List templates (always includes immutable `system-default`) |
| GET | `/effective-default` | Currently active decline template (for prefill) |
| POST | `/` | Create custom template |
| PATCH | `/:id` | Edit custom template (fails for `system-default`) |
| POST | `/:id/set-default` | Set active default (works for `system-default`) |
| DELETE | `/:id` | Delete custom template (fails for `system-default`) |

### `/api/v1/preferences`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Read user preferences (reminder lead time, etc.) |
| PUT | `/` | Update user preferences |

### `/api/v1/google` (live Google data proxy)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/calendar/events` | Live Google Calendar events |
| GET | `/gmail/messages` | List Gmail messages (paginated) |
| GET | `/gmail/messages/:messageId` | Single message |
| GET | `/gmail/inbox` | Inbox listing |
| GET | `/gmail/sent` | Sent listing |
| POST | `/gmail/send-automated-response` | Send an AI/automated email response |
| POST | `/maps/distance` | Distance/travel-time lookup (Google Maps) |

### `/api/v1/reminders`
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/compute` | Compute reminder schedule (app sends device location here) |

### `/api/v1/push-tokens`
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/` | Register Expo push token |
| GET | `/` | List registered tokens |
| DELETE | `/:id` | Remove a token |

### `/api/v1/workflows`
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/executions` | List workflow executions |
| GET | `/executions/:id` | Execution detail |
| POST | `/actions` | Signed workflow action callback (e.g. from email links) |

### `/api/v1/accountant` (Professional Mode — Accountant)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/insights` | AI (Gemini) AR insights: prioritized, risk-scored collection plan + client risk notes |
| GET | `/invoices` | List invoices (optional `?status=open\|overdue\|reminded\|paid`) |
| GET | `/invoices/:id` | Invoice detail |
| POST | `/invoices/:id/preview-reminder` | Generate a draft **without sending** (`{ regenerate?, escalationTone? }`) |
| POST | `/invoices/:id/send-reminder` | Dunning send; optional `{ subject, body }` = edited draft (skips AI) |
| GET | `/invoices/:id/reminder-logs` | Per-invoice reminder send history |
| POST | `/invoices/bulk-remind/preview` | Tailored drafts for overdue (or `{ invoiceIds }`) |
| POST | `/invoices/bulk-remind/send` | Send a reviewed batch (`{ items:[{invoiceId,subject?,body?}] }`) |
| GET | `/expenses` | List expenses (optional `?status=pending\|flagged\|approved\|dismissed`) |
| GET | `/expenses/:id` | Expense detail |
| POST | `/expenses/audit` | Run Gemini audit → flag anomalies (duplicate/missing-receipt/policy/uncategorized) |
| POST | `/expenses/:id/resolve` | `{ action: 'approve' \| 'dismiss' }` |
| GET | `/reports/flash` | Gemini flash financial report (AR + cash + insights + recommendations) |
| POST | `/reports/flash/email` | Email the flash report to the user's own inbox |
| POST | `/assistant/chat` | "Ask your AI accountant" — `{ message, history? }`, grounded in the user's data |
| GET | `/assistant/history` | Recent assistant conversation |
| POST | `/scan` | Mark overdue (open→overdue past due) + push-notify; weekly via QStash Schedule in prod |
| POST | `/seed-demo` | Seed demo invoices (+ paid history) **and expenses with anomalies** for the user |

All AI uses the **Professional-Mode provider (Gemini, `gemini-2.5-flash`)**; set
`PROFESSIONAL_AI_PROVIDER=demo` to run offline (deterministic fallbacks). Every generator is
JSON-only, Zod-validated, and cached in `ai_outputs`. **Dunning send** mirrors
`events/:id/send-decline-email` (synchronous, returns the sent email). Reminders address
`client_email`; demo invoices use the caller's own email so sends are verifiable. See
[doc/accountant-agent.md](doc/accountant-agent.md).

### `/api/v1/workers` (internal — QStash callbacks, `Upstash-Signature` verified)
`POST /calendar-sync`, `/triggers`, `/workflow`, `/conflicts`, `/notifications`, `/email`, `/dlq`.
Not called directly — published to via `enqueueJob()`. See [CLAUDE.md](CLAUDE.md) for the retry contract.

### `/health`
`GET /health` → `{ "status": "ok", ... }` (no auth).

## Decline send behavior (the core MVP flow)

`POST /events/:id/send-decline-email` accepts an optional body:

```json
{
  "templateId": "system-default",   // optional; omit to use effective default
  "customSubject": "Unable to attend",  // optional override
  "customBody": "Hi, I can't make it.", // optional override
  "sendToOrganizer": true,          // default true
  "sendToAttendees": true           // default true
}
```

Backend steps: load event → resolve recipients from organizer/attendees → exclude the
authenticated user's own email → resolve template (or effective default) → render
subject/body with event placeholders → send via Gmail → write an `email_send_logs` row
(`sent` / `already_sent` / `failed`) → record attendance as `no`. The event row is **not**
deleted. Template placeholders include `{{eventTitle}}`, `{{eventStart}}`.

```bash
# Simplest: decline using the effective default template
curl -X POST 'http://localhost:5000/api/v1/events/<EVENT_ID>/send-decline-email' \
  -H 'Authorization: Bearer <JWT>' -H 'Content-Type: application/json' -d '{}'
```

## Negative tests worth keeping green
- No `Authorization` header → `401`.
- `POST /calendar/sync?provider=microsoft` → rejected (Google-only).
- `GET /events/<random-uuid>` → `404`.
- `PATCH` or `DELETE` on `email-templates/system-default` → must fail (immutability).
- `send-decline-email` with `"customSubject": ""` → `400` validation error.
- `attendance-response` with `"response": "maybe"` → `400` validation error.

## Keep this current
Update this file whenever routes change. The route source of truth is `src/app.ts` (mount
points) and the `src/routes/*.routes.ts` files.
