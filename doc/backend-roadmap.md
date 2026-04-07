# AI-Based Calendar & Task Automation Platform

## Backend Architecture & Implementation Plan

---

## 1. SYSTEM GOALS

Build a backend system that:

- Syncs user calendars (Google / Outlook)
- Stores and normalizes calendar events
- Detects conflicts and time-based triggers
- Sends smart, actionable notifications
- Uses AI to draft contextual emails (declines, reschedules, follow-ups)
- Scales to arbitrary future event types and automations

The system must:

- Be deterministic where correctness matters
- Use AI only for language and context generation
- Be workflow-driven (data-defined, not hard-coded)
- Support horizontal scaling
- Be safe (idempotent, retryable, auditable)

---

## 2. TECH STACK (MANDATORY)

### Core

- Node.js + Express (TypeScript REQUIRED)
- PostgreSQL
- Supabase Auth (JWT-based)
- Redis (job queue + deduplication)
- BullMQ (or equivalent)
- Background workers (separate process)

### External Integrations

- Google Calendar API
- Microsoft Graph Calendar API
- Gmail API / Outlook Mail API
- Push notifications (FCM) or Email/SMS fallback

### AI

- Single LLM provider behind abstraction
- JSON-only structured outputs
- No agent loops

---

## 3. HIGH-LEVEL ARCHITECTURE

```mermaid
graph TD
    Client --> API_Gateway[API Gateway (Express)]
    API_Gateway --> Core_Services
    subgraph Core_Services
        Auth[Auth (Supabase)]
        Calendar_Sync
        Event_Normalizer
        Workflow_Engine
        Notification_Engine
        AI_Service
        Email_Service
    end
    Core_Services --> DB[(PostgreSQL)]
    Core_Services --> Queue[[Redis Queue]]
    Queue --> Workers[Worker Processes]
```

---

## 4. DATA MODEL (SCALABLE BY DESIGN)

### 4.1 USERS

```sql
users (
  id UUID PRIMARY KEY,
  email TEXT,
  timezone TEXT,
  created_at TIMESTAMP
)
```

### 4.2 CONNECTED ACCOUNTS

```sql
connected_accounts (
  id UUID PRIMARY KEY,
  user_id UUID,
  provider TEXT, -- google, microsoft
  access_token TEXT ENCRYPTED,
  refresh_token TEXT ENCRYPTED,
  expires_at TIMESTAMP,
  created_at TIMESTAMP
)
```

### 4.3 EVENTS (NORMALIZED)

```sql
events (
  id UUID PRIMARY KEY,
  user_id UUID,
  external_event_id TEXT,
  provider TEXT,
  event_type TEXT, -- "pt_meeting", "class", "exam", "standup"
  title TEXT,
  description TEXT,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  organizer_email TEXT,
  attendees JSONB,
  is_recurring BOOLEAN,
  metadata JSONB,
  updated_at TIMESTAMP,
  created_at TIMESTAMP
)
```

⚠️ `event_type` is EXTENSIBLE. New event types never require schema changes.

### 4.4 EVENT SNAPSHOTS (FOR CONFLICT AUDIT)

```sql
event_snapshots (
  id UUID PRIMARY KEY,
  event_id UUID,
  snapshot JSONB,
  created_at TIMESTAMP
)
```

### 4.5 WORKFLOWS (AUTOMATIONS)

```sql
workflows (
  id UUID PRIMARY KEY,
  name TEXT,
  trigger_type TEXT,
  definition JSONB,
  is_active BOOLEAN,
  created_at TIMESTAMP
)
```

Workflow definitions are JSON graphs (see section 7).

### 4.6 WORKFLOW EXECUTIONS

```sql
workflow_executions (
  id UUID PRIMARY KEY,
  workflow_id UUID,
  user_id UUID,
  status TEXT, -- pending, running, completed, failed
  context JSONB,
  current_step TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
)
```

### 4.7 JOBS (SCHEDULED TASKS)

```sql
jobs (
  id UUID PRIMARY KEY,
  dedupe_key TEXT UNIQUE,
  run_at TIMESTAMP,
  status TEXT,
  payload JSONB,
  created_at TIMESTAMP
)
```

### 4.8 AI GENERATED CONTENT

```sql
ai_outputs (
  id UUID PRIMARY KEY,
  execution_id UUID,
  output_type TEXT, -- email_draft, summary
  content JSONB,
  created_at TIMESTAMP
)
```

---

## 5. CALENDAR SYNC ENGINE

### 5.1 OAuth Flow

- Use Supabase Auth for user identity
- Store provider tokens encrypted
- Refresh tokens automatically

### 5.2 Webhooks / Subscriptions

- Google: watch channels
- Microsoft: Graph subscriptions
- On change:
  1. Fetch updated event
  2. Normalize into events
  3. Save snapshot
  4. Trigger workflow evaluation

### 5.3 Normalization Rules

All events map to:

```javascript
NormalizedEvent {
  id,
  userId,
  title,
  startTime,
  endTime,
  organizer,
  attendees,
  provider,
  eventType,
  metadata
}
```

---

## 6. CONFLICT DETECTION ENGINE

### Logic (NO AI)

- Detect overlaps by time
- Respect buffers (user-defined)
- Identify:
  - required vs optional attendee
  - organizer priority
  - recurring exceptions

### Conflict output:

```json
{
  "conflictingEvents": ["eventA", "eventB"],
  "conflictType": "overlap",
  "severity": "high"
}
```

Triggers workflows, not actions.

---

## 7. WORKFLOW ENGINE (CORE SCALABILITY)

### 7.1 Workflow Definition Format

```json
{
  "trigger": "calendar.event.updated",
  "conditions": [{ "type": "conflict_exists" }],
  "steps": [
    { "id": "notify_user", "type": "notify" },
    { "id": "wait_response", "type": "wait_for_input" },
    {
      "id": "branch",
      "type": "branch",
      "routes": {
        "keep_event_a": "decline_event_b",
        "keep_event_b": "decline_event_a"
      }
    },
    {
      "id": "generate_email",
      "type": "ai_generate_email"
    },
    {
      "id": "send_email",
      "type": "email_send"
    }
  ]
}
```

### 7.2 Step Types

- `notify`
- `wait_for_input`
- `branch`
- `wait_until`
- `ai_generate_email`
- `email_generate_preview` ← preferred: AI generation + preview loop + attendee guard + multi-recipient
- `email_send`
- `email_draft_create`
- `calendar_decline`
- `calendar_reschedule`
- `log`

### 7.3 Execution Rules

- Every step is idempotent
- Steps write state before and after execution
- Failures retry safely

---

## 8. NOTIFICATION ENGINE

### Capabilities

- Push notifications with actions
- Email fallback
- Deep links with signed tokens

### Example payload:

```json
{
  "title": "Meeting Conflict",
  "actions": ["Keep A", "Keep B", "Reschedule"]
}
```

---

## 9. AI EMAIL GENERATION

### Inputs

- Event details and conflict context
- All external attendees of the conflicting events (excluding the user themselves)
- Optional meeting notes
- User tone preference

### Output (STRICT JSON)

```json
{
  "subject": "...",
  "body": "...",
  "reason": "...",
  "proposed_times": ["..."]
}
```

### Rules

- AI never sends emails directly
- Always preview or draft
- Validate schema
- Fallback to template
- **Attendee guard**: if the conflicting events have no external attendees (no one to notify), the email step is automatically skipped before any AI call is made — no token is wasted

---

## 10. EMAIL ENGINE

### Options

- Gmail API: create draft → send via `users.drafts.send`
- Outlook Mail API (future)

### Implemented flow:

1. `email_generate_preview` step queries DB for external attendees, skips if none
2. AI generates draft
3. User reviews, regenerates (loop), or skips
4. On approval, `email_send` step:
   - Resolves full recipient list (`recipientEmails: string[]`) — all attendees of both conflicting events, user's own email excluded
   - Calls `sendEmail()` → `createGmailDraft()` + `sendGmailDraft()` (both idempotent)
   - MIME `To:` header lists all recipients in a single email
   - Persists send record in `email_drafts` with `sent_at`

---

## 11. SCALABILITY STRATEGY

### Horizontal Scaling

- Stateless API servers
- Workers scale independently
- Redis-backed queues

### Adding New Event Types

1. Add `event_type`
2. Add workflow definition
3. **No** schema changes

### Adding New Automations

1. Define new workflow JSON
2. Attach trigger
3. Deploy

---

## 12. SECURITY & SAFETY

- Encrypt tokens
- Least privilege OAuth scopes
- Audit logs for every action
- User approval before destructive actions
- Rate limiting

---

## 13. PHASE-WISE ROADMAP

### Phase 1 — Foundation (Week 1–2)

- Auth
- Calendar sync
- Event storage
- Basic conflict detection

### Phase 2 — Smart Notifications (Week 3)

- Job scheduler
- T-30 / T-10 reminders
- Yes/No confirmation

### Phase 3 — AI Email Drafts (Week 4)

- AI service
- Draft generation
- Email preview + send

### Phase 4 — Workflow Engine (Week 5)

- Workflow definitions
- Branching logic
- Execution state

### Phase 5 — Event Types Expansion (Week 6)

- PT meetings
- Classes
- Exams
- Standups

### Phase 6 — Notes & Context (Week 7+)

- Meeting notes
- Structured retrieval
- (Optional) embeddings

---

## 14. WHAT NOT TO DO

- ❌ Hard-code PT meeting logic
- ❌ Let AI decide actions
- ❌ Poll calendars instead of webhooks
- ❌ Send emails without preview
- ❌ Skip idempotency

---

## 15. FINAL NOTE

This backend is a general-purpose AI automation engine, not a calendar app.
Calendars are just one trigger source.

If built correctly, future automations (email triage, task creation, follow-ups, reminders) plug in without refactors.
