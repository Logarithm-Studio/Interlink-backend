# Interlink Backend — Completion Plan (Production-Grade)

## Scope and constraints

- Tech stack is fixed: Node.js + Express (TypeScript), PostgreSQL, Supabase Auth (JWT), Redis, BullMQ, background workers (separate process), Google Calendar API, Microsoft Graph Calendar API, Gmail/Outlook Mail APIs.
- AI is permitted only for structured content generation (JSON). AI has zero decision authority.
- Calendar change ingestion must be webhook/subscription driven. No polling loops.
- Workflows must be data-driven via JSON definitions. No hard-coded logic for specific event types.
- All side effects must be idempotent, retryable, and auditable.

---

## 1) Current System Audit

### 1.1 Repository structure (present)

- API entrypoints
  - `src/server.ts`: starts Express and validates env vars; tests Postgres + Redis connectivity.
  - `src/app.ts`: Express middleware + route registration + global error handler.
- Configuration
  - `src/config/db.ts`: PostgreSQL `pg.Pool` singleton + `query()` helper + `testConnection()`.
  - `src/config/redis.ts`: `ioredis` singleton + `testRedisConnection()`.
  - `src/config/supabase.ts`: Supabase client singleton using `SUPABASE_URL` + `SUPABASE_KEY`.
- Middleware
  - `src/middleware/auth.ts`: verifies a Supabase JWT by calling `supabase.auth.getUser(token)` and upserts a row into `users`.
- Routes
  - `src/routes/auth.routes.ts`: Google OAuth connect + callback + `/me` introspection.
  - `src/routes/calendar.routes.ts`: manual sync endpoint + Google webhook endpoint (explicit stub).
  - `src/routes/events.routes.ts`: list/get/delete events + run conflict detection.
  - `src/routes/events.routes.ts`: decline-email send + decline-email send-log endpoints exist, but the decline-email route does not mutate event lifecycle state.
- Services
  - `src/services/auth.service.ts`: stores tokens in DB + refreshes Google access tokens.
  - `src/services/calendar/google.ts`: fetches Google events via `calendar.events.list`.
  - `src/services/calendar/normalizer.ts`: normalizes Google event objects.
  - `src/services/calendar/sync.ts`: orchestrates fetching + normalization + upsert.
  - `src/services/events.service.ts`: upsert/list/get/delete events + snapshots on update.
  - `src/services/conflicts.service.ts`: detects overlaps via SQL self-join.
  - `src/services/email/declineEmail.service.ts`: sends Gmail decline mail and writes explicit send logs, but does not mark the event declined/cancelled or remove it from future notification paths.
- Types
  - `src/types/index.ts`: core types for user, connected accounts, normalized events, conflicts.
- Utilities
  - `src/utils/errors.ts`: `AppError` hierarchy + Express error middleware.

### 1.2 Database migrations (present)

Migration runner:

- `src/db/migrations/runner.ts` applies `*.sql` files and tracks them in `_migrations`.

Applied schema coverage (current files):

- `001_users.sql`: `users(id, email, timezone, created_at)`.
- `002_connected_accounts.sql`: `connected_accounts` storing provider tokens.
- `003_events.sql`: `events` normalized event table.
- `004_event_snapshots.sql`: `event_snapshots` audit trail.

Missing from roadmap schema:

- `workflows`, `workflow_executions` (and step state), `jobs`, `ai_outputs`.
- Any webhook/subscription/channel tables.
- Any audit log table for side effects.

### 1.3 Infrastructure configuration status

- PostgreSQL: configured (Supabase-hosted Postgres URL) and connection is tested at startup.
- Redis: configured (Upstash) and PING tested at startup.
- Supabase Auth: integrated by remote token introspection (`auth.getUser`).
- BullMQ: dependency exists (`bullmq`), but there is no queue configuration, producer, or worker process.

### 1.4 Auth flow status

Implemented:

- API auth middleware validates Supabase JWT and attaches `req.user`.
- Local `users` table is upserted on every authenticated request.

Incorrect / unsafe (must be fixed):

- OAuth connect endpoint `GET /api/v1/auth/google?token=<JWT>` passes a JWT as a query param and forwards it into OAuth `state`.
  - This leaks in browser history, logs, proxies, referrers, and monitoring tooling.
  - `state` is intended for CSRF protection, not as a bearer credential.
- Supabase verification is done via a network call to Supabase for every request (`auth.getUser`). This is functional but not production-grade for latency/availability. Production requires local JWT verification (JWKS) with caching.

### 1.5 Calendar sync status

Implemented:

- Manual sync endpoint: `POST /api/v1/calendar/sync?provider=google&since=<iso>`.
- Google events fetch: `calendar.events.list` using an access token refreshed when near expiry.
- Normalization: Google events mapped into `NormalizedEvent`.
- Persistence: `upsertEvent()` dedupes by `(user_id, external_event_id, provider)`.
- Snapshotting: snapshots are written on UPDATE (using `xmax` heuristic).

Partially implemented:

- Webhook endpoint exists: `POST /api/v1/calendar/webhook/google`.
  - It only logs headers and returns 200; it does not verify, map to user, or enqueue work.

Incorrect vs required architecture:

- Sync is effectively polling (manual API-driven fetch). Roadmap requires webhook-driven ingestion.
- No Google channel creation (`events.watch`) or renewal strategy exists.
- No incremental sync cursor (`syncToken`) is stored or used.
- Google token refresh uses a legacy refresh call path; it must be aligned with the current `googleapis`/auth library APIs and treated as a first-class failure mode (reauth required vs transient).

### 1.6 Event type handling status

Incorrect vs constraints:

- `src/services/calendar/normalizer.ts` contains hard-coded heuristics to infer event types (standup/exam/class/pt_meeting/1:1).
- Constraint requires: no hard-coded logic for specific event types; event classification must be data-defined.

### 1.7 Conflict detection status

Implemented (minimal):

- Deterministic overlap detection for a single user using a SQL self-join.
- Severity is inferred from attendee optionality in a simplistic manner.

Missing:

- Buffers, recurring exception handling, organizer priority, required vs optional attendee semantics beyond a boolean, and consistent trigger output for workflow engine.

### 1.8 Worker setup status

Missing:

- No worker entrypoint (separate process).
- No BullMQ queues, job schemas, retry policies, or dedupe.
- No dead-letter handling.

### 1.9 Workflow engine status

Missing:

- No `workflows` storage.
- No execution state machine.
- No step registry/handlers.
- No triggers from calendar updates/conflicts.

### 1.10 Notification engine status

Missing:

- No notification service.
- No push/email fallback.
- No signed deep links.
- No workflow resume endpoints.

### 1.11 AI service status

Missing:

- No LLM abstraction.
- No JSON schema enforcement.
- No persistence in `ai_outputs`.

### 1.12 Email service status

Missing:

- No Gmail draft/send.
- No Outlook mail integration.
- No “draft-only then confirm send” flow.

---

## 2) Gap Analysis

### 2.1 Infrastructure

Missing/incomplete:

- `.env` file placement: runtime uses `dotenv.config()` with default path; repo currently has environment variables in `src/.env` (not auto-loaded from project root). This causes startup failure unless env vars are exported externally.
- BullMQ connection wiring.
- Worker process packaging/build/run scripts.

### 2.2 Calendar Sync Engine

Missing:

- OAuth connect flow without bearer-in-query leakage; server-side state storage.
- Token encryption at rest (access/refresh tokens are currently plaintext in Postgres).
- Google watch channel creation (`events.watch`) and renewal prior to expiration.
- Channel-to-user mapping table.
- Incremental sync using `syncToken`.
- Webhook verification (channel token / resource ID validation).
- Deterministic handling of deletes/cancellations.
- Microsoft Graph subscriptions: creation, renewal, validation, and delta sync.

### 2.3 Conflict Detection Engine

Missing:

- Buffer windows and user-specific default buffers.
- Recurring series and exception semantics.
- Organizer priority and attendee requirement parsing.
- Stable severity scoring model.
- Emitting workflow triggers on conflict changes (new/cleared/changed).

### 2.4 Workflow Engine

Missing:

- DB schema for workflow definitions and executions (including per-step state).
- Trigger evaluation layer: map incoming events → eligible workflows.
- Execution runner implemented as workers.
- Step registry with strict idempotency contracts.
- Wait states (`wait_until`, `wait_for_input`) with timeouts.
- Branch routing logic.

### 2.5 Job Scheduling System

Missing:

- Queues + job types + payload schemas.
- Dedupe keys.
- Retry/backoff policies.
- Dead-letter strategy.

### 2.6 AI Email Generation

Missing:

- Provider abstraction.
- Prompt templates and strict JSON-only responses.
- Zod validation and fallback templates.
- Rate limiting and auditing.

### 2.7 Notification System

Missing:

- Push payload schema + deep link signing.
- Delivery drivers (FCM / email fallback).
- Workflow resume endpoints.

### 2.8 Email Sending System

Missing:

- Gmail API integration (draft creation, not direct send).
- Outlook Mail API integration (draft creation).
- User confirmation flow tied to workflow steps.
- Decline-email send must also drive event lifecycle state (`declined`, `cancelled`, or local suppression/removal); otherwise later workflow/notification processing can continue for the same event.

### 2.9 Security & Idempotency

Missing/incorrect:

- Token encryption at rest.
- Auth verification should be local JWT verification with cached JWKS.
- OAuth CSRF protection should use random server-side state.
- Idempotency keys on mutating API endpoints.
- Replay protection for webhook callbacks.
- Rate limiting and abuse prevention.

### 2.10 Observability & Logging

Missing:

- Structured logs (request ID, user ID, execution ID, job ID).
- Worker/job metrics and queue depth monitoring.
- Audit logs for all side effects.

---

## 3) Execution Plan (Strict Serial Order)

This section is the build order. Each step must land before the next begins. Every step below uses the same execution checklist.

### Step 1 — Normalize configuration loading and secrets handling

Goal

- Ensure runtime loads environment variables deterministically and avoids committing secrets.

Why now

- All subsequent work depends on stable configuration and secure secret handling.

Files to create

- `.env.example` (required keys only; no secrets).

Files to modify

- `src/server.ts`: load dotenv from a deterministic path (e.g., `DOTENV_PATH` override) or relocate the env file to project root.
- `.gitignore`: ensure `.env` (and any local secret files) are ignored.

Database changes

- N/A.

Redis/BullMQ queues

- N/A.

Worker responsibilities

- N/A.

API routes

- N/A.

Edge cases

- Production uses injected env vars; `.env` is local-only.

Idempotency / retries

- N/A.

### Step 2 — Add base schema for workflows, executions, jobs, AI outputs, and audit logging

Goal

- Add missing core tables required by the roadmap.

Why now

- Worker/job orchestration and workflow execution persistence cannot exist without schema.

Files to create

- `src/db/migrations/005_workflows.sql`
- `src/db/migrations/006_workflow_executions.sql`
- `src/db/migrations/007_jobs.sql` (only if a DB-level job ledger is required)
- `src/db/migrations/008_ai_outputs.sql`
- `src/db/migrations/009_audit_log.sql`

Files to modify

- N/A (runner already applies new migrations).

Database changes

- `workflows`
  - `id uuid pk default gen_random_uuid()`
  - `name text not null`
  - `trigger_type text not null`
  - `definition jsonb not null`
  - `is_active boolean not null default true`
  - `created_at timestamptz not null default now()`
- `workflow_executions`
  - `id uuid pk default gen_random_uuid()`
  - `workflow_id uuid not null references workflows(id)`
  - `user_id uuid not null references users(id)`
  - `status text not null` (pending|running|waiting|completed|failed)
  - `context jsonb not null default '{}'::jsonb`
  - `current_step text`
  - `created_at, updated_at timestamptz`
- `workflow_execution_steps`
  - `id uuid pk default gen_random_uuid()`
  - `execution_id uuid not null references workflow_executions(id)`
  - `step_id text not null`
  - `status text not null` (pending|running|waiting|completed|failed)
  - `attempt int not null default 0`
  - `input jsonb not null default '{}'::jsonb`
  - `output jsonb not null default '{}'::jsonb`
  - `error jsonb`
  - `started_at, finished_at timestamptz`
  - `next_run_at timestamptz`
  - unique constraint on `(execution_id, step_id)`
- `ai_outputs`
  - `id uuid pk default gen_random_uuid()`
  - `execution_id uuid references workflow_executions(id)`
  - `output_type text not null`
  - `content jsonb not null`
  - `created_at timestamptz not null default now()`
- `audit_log`
  - `id uuid pk default gen_random_uuid()`
  - `user_id uuid references users(id)`
  - `actor_type text not null` (api|worker|system)
  - `action text not null`
  - `entity_type text`
  - `entity_id uuid`
  - `idempotency_key text`
  - `request_id text`
  - `payload jsonb not null default '{}'::jsonb`
  - `created_at timestamptz not null default now()`
  - unique index on `(action, idempotency_key)` where `idempotency_key is not null`

Redis/BullMQ queues

- N/A.

Worker responsibilities

- N/A.

API routes

- N/A.

Edge cases

- Migration runner currently assumes SQL files are transaction-safe; all migrations must remain transaction-safe.

Idempotency / retries

- `audit_log.idempotency_key` becomes the durable dedupe primitive for side effects.

### Step 3 — Introduce BullMQ infrastructure and a separate worker process

Goal

- Establish queues, producers, and worker runtime as a separate Node process.

Why now

- Webhook ingestion and workflow execution must be asynchronous and retryable.

Files to create

- `src/queues/connection.ts` (BullMQ connection from `REDIS_URL`)
- `src/queues/queues.ts` (queue instances)
- `src/jobs/schemas/*.ts` (Zod payload schemas)
- `src/worker.ts` (worker entrypoint)
- `src/workers/index.ts` (register processors)
- `src/workers/processors/*.ts` (processors per queue/job type)

Files to modify

- `package.json`: add `worker:dev` and `worker:start` scripts.

Database changes

- N/A.

Redis/BullMQ queues

- Create queues listed in section 4.

Worker responsibilities

- Start one Worker per queue with explicit concurrency.
- Attach `QueueEvents` listeners for failure accounting and DLQ forwarding.

API routes

- N/A.

Edge cases

- Redis TLS configuration (Upstash `rediss://`) must be supported.

Idempotency / retries

- Every job must use a deterministic `jobId` derived from a stable dedupe key.

### Step 4 — Replace insecure OAuth state handling with server-side state

Goal

- Remove JWT-in-query and implement a secure connect flow.

Why now

- Current OAuth state handling leaks bearer credentials and breaks CSRF guarantees.

Files to create

- `src/services/oauth-state.service.ts` (Redis-backed state storage with TTL + single-use semantics)

Files to modify

- `src/routes/auth.routes.ts`
  - Replace `GET /google?token=...` with `GET /google` protected by `authMiddleware`.
  - Generate `oauth_state` (128-bit random) and store `{ userId, provider }` in Redis with TTL (10 minutes).
  - Use OAuth `state=oauth_state`.
  - Callback resolves and consumes `oauth_state` from Redis.

Database changes

- N/A.

Redis/BullMQ queues

- N/A.

Worker responsibilities

- N/A.

API routes

- `GET /api/v1/auth/google` (authenticated redirect)
- `GET /api/v1/auth/callback/google` (OAuth callback)

Edge cases

- Callback replay must fail (state is single-use).
- TTL expiry must fail closed.

Idempotency / retries

- Callback handler must be idempotent by upserting the connected account.

### Step 5 — Encrypt provider tokens at rest

Goal

- Store OAuth tokens encrypted and never persist plaintext tokens.

Why now

- Plaintext bearer tokens in Postgres violate baseline security requirements.

Files to create

- `src/security/crypto.ts` (AES-256-GCM encrypt/decrypt)
- `src/security/keyring.ts` (key selection by `kid`, rotation support)

Files to modify

- `src/services/auth.service.ts`: encrypt on write, decrypt on read; treat decrypt failure as permanent (reauth required).

Database changes

- New migration `010_connected_accounts_encryption.sql`
  - Add encrypted token columns (`*_enc`, `enc_iv`, `enc_tag`, `enc_kid`).
  - One-time backfill: encrypt existing plaintext tokens and null plaintext columns.

Redis/BullMQ queues

- N/A.

Worker responsibilities

- N/A.

API routes

- N/A.

Edge cases

- Key rotation must support decrypting old rows.

Idempotency / retries

- Encryption uses random IV; ciphertext is non-deterministic. Idempotency is enforced at the DB row level (upsert by `(user_id, provider)`).

### Step 6 — Make calendar sync webhook-driven (Google watch channels)

Goal

- Implement Google `events.watch` channels, webhook verification, and enqueue incremental sync jobs.

Why now

- Webhook-driven ingestion is a mandatory architectural constraint.

Files to create

- `src/services/calendar/googleWatch.service.ts` (create/renew watch channels)
- `src/services/calendar/googleSyncCursor.service.ts` (persist `syncToken`)
- `src/workers/processors/googleSync.processor.ts` (job processor)

Files to modify

- `src/routes/calendar.routes.ts`
  - Implement `POST /webhook/google` to validate headers:
    - `x-goog-channel-id`, `x-goog-resource-id`, `x-goog-resource-state`, `x-goog-message-number`
    - verify optional `x-goog-channel-token` against stored `channel_token`
  - Look up channel by `channel_id`, verify `resource_id`, enqueue sync job.

Database changes

- New migration `011_google_channels.sql`
  - `google_watch_channels(user_id, channel_id unique, resource_id, channel_token, expiration, sync_token, calendar_id, created_at, updated_at)`

Redis/BullMQ queues

- `calendar-sync`: `calendar.google.sync` and `calendar.google.watch.renew`.

Worker responsibilities

- `calendar.google.watch.renew`: renew channels before `expiration`.
- `calendar.google.sync`: run incremental sync and update stored `sync_token`.

API routes

- `POST /api/v1/calendar/webhook/google`

Edge cases

- `resource_state=sync` initial notification.
- Webhook bursts: coalesce using short Redis dedupe keys.
- Missing/invalid tokens: fail closed without enqueuing.

Idempotency / retries

- Sync job `jobId` derived from `channel_id + message_number` (or coalesced window key).
- Event writes are idempotent via upsert unique constraint.

### Step 7 — Implement incremental sync using Google `syncToken`

Goal

- Replace time-window event listing with incremental change ingestion.

Why now

- Time-window listing is polling-like, expensive, and loses true change semantics.

Files to modify

- `src/services/calendar/google.ts`: add incremental fetch path using `syncToken`.
- `src/services/calendar/sync.ts`: split into `fullSync` and `incrementalSync`.

Files to create

- N/A (unless extracting shared pagination helpers).

Database changes

- Persist `sync_token` per watch channel.

Redis/BullMQ queues

- Uses `calendar-sync` queue jobs from Step 6.

Worker responsibilities

- Handle `410 Gone` by clearing the cursor and enqueueing a full resync job.

API routes

- N/A.

Edge cases

- `nextSyncToken` only appears on the final page.
- Rate limiting and partial failures must not corrupt cursor.

Idempotency / retries

- Cursor updates must be transactional with event upserts (update cursor only after successful page ingestion).

### Step 8 — Remove hard-coded event type heuristics; make classification data-driven

Goal

- Eliminate hard-coded event-type inference and replace with rule-driven classification.

Why now

- Hard-coded event-type heuristics violate constraints and create unreviewable behavior changes.

Files to create

- `src/services/eventTypeRules.service.ts` (load/evaluate rules)

Files to modify

- `src/services/calendar/normalizer.ts`: remove heuristic mapping; apply rule evaluation; default to `general`.

Database changes

- New migration `012_event_type_rules.sql`
  - `event_type_rules(user_id null, provider null, priority int, rule jsonb, event_type text, is_active boolean, created_at)`

Redis/BullMQ queues

- N/A.

Worker responsibilities

- N/A.

API routes

- Optional (later): CRUD for rules (not required for core completion).

Edge cases

- Rule evaluation must be deterministic, total-order by `priority`, and side-effect free.

Idempotency / retries

- Classification is pure; persistence is idempotent via event upsert.

### Step 9 — Standardize webhook replay protection and request idempotency

Goal

- Prevent webhook replay and duplicate side effects across API and workers.

Why now

- At-least-once delivery is guaranteed; duplicates are the normal case.

Files to create

- `src/security/idempotency.ts` (Redis dedupe primitives + header parsing)

Files to modify

- `src/routes/calendar.routes.ts`: dedupe on `(channel_id, resource_id, message_number)`.
- Mutating routes (as they’re added): require `Idempotency-Key` header.

Database changes

- Use `audit_log` unique `(action, idempotency_key)` for durable side-effect dedupe.

Redis/BullMQ queues

- N/A.

Worker responsibilities

- Processors must compute and record effect-level idempotency keys.

API routes

- N/A.

Edge cases

- Dedupe TTL must exceed maximum webhook retry window.

Idempotency / retries

- Redis short-window dedupe + DB durable dedupe.

### Step 10 — Introduce trigger emission and evaluation pipeline

Goal

- Convert event changes and conflict results into workflow triggers.

Why now

- Workflows are the core runtime; triggers are the only entrypoint.

Files to create

- `src/triggers/types.ts` (canonical trigger payload schemas)
- `src/triggers/emitter.ts` (enqueue `trigger.emit`)
- `src/workers/processors/trigger.processor.ts` (evaluate triggers → create executions)

Files to modify

- `src/services/events.service.ts`: enqueue trigger after upsert/delete.

Database changes

- N/A (uses `workflows` and `workflow_executions` from Step 2).

Redis/BullMQ queues

- `triggers`: `trigger.emit`, `trigger.evaluate`.

Worker responsibilities

- `trigger.evaluate`: load active workflows by trigger type, evaluate conditions deterministically, create executions, enqueue `workflow.run`.

API routes

- N/A.

Edge cases

- Trigger duplication: enforce dedupe by deterministic `jobId` and DB uniqueness where applicable.

Idempotency / retries

- `jobId = trigger:<triggerType>:<userId>:<entityId>:<observedAtBucket>`.

### Step 11 — Implement workflow engine persistence + runner

Goal

- Execute workflow steps asynchronously with durable step state.

Why now

- Required for notifications, AI drafts, and calendar/email side effects.

Files to create

- `src/workflow/definition.ts` (Zod schema for definitions)
- `src/workflow/state.ts` (state transitions)
- `src/workflow/registry.ts` (step registry)
- `src/workflow/engine.ts` (runner)
- `src/services/workflows.service.ts` (DB read/write)
- `src/workers/processors/workflow.processor.ts` (queue integration)

Files to modify

- `src/app.ts`: register workflow action routes once implemented.

Database changes

- N/A (Step 2 tables).

Redis/BullMQ queues

- `workflow`: `workflow.run`, `workflow.resume`, `workflow.timeout`.

Worker responsibilities

- `workflow.run`: run a single step, persist results, enqueue next.
- `workflow.resume`: validate resume token/action, continue execution.
- `workflow.timeout`: enforce definition-controlled timeouts.

API routes

- `POST /api/v1/workflows/actions` (authenticated): resume execution via signed token.

Edge cases

- Concurrent runners: enforce optimistic concurrency on `workflow_executions`.

Idempotency / retries

- Step rows have unique `(execution_id, step_id)`; a completed step is never executed again.

### Step 12 — Implement wait states and timeouts without blocking

Goal

- Support `wait_until` and `wait_for_input` as durable waiting.

Why now

- User interaction is core; blocking is forbidden.

Files to create

- `src/workflow/steps/wait_until.ts`
- `src/workflow/steps/wait_for_input.ts`

Files to modify

- `src/workflow/registry.ts`: register new step handlers.

Database changes

- N/A.

Redis/BullMQ queues

- Uses `workflow` queue delayed jobs.

Worker responsibilities

- `wait_until`: enqueue delayed `workflow.resume`.
- `wait_for_input`: persist `waiting` and schedule a `workflow.timeout` job.

API routes

- Uses `POST /api/v1/workflows/actions` for resume.

Edge cases

- Timeout job must verify the execution is still waiting on the same step.

Idempotency / retries

- Resume jobs deduped by `(execution_id, step_id, resume_reason)`.

### Step 13 — Expand conflict engine and emit conflict triggers

Goal

- Add buffers, attendee semantics, organizer priority, recurring exception support, and stable severity scoring.

Why now

- Conflict triggers are a primary automation input.

Files to modify

- `src/services/conflicts.service.ts`: split into candidate selection (SQL) and deterministic scoring (TS).

Files to create

- `src/workers/processors/conflicts.processor.ts`: consume `conflicts.detect` jobs and emit triggers.

Database changes

- `013_user_preferences.sql`: `user_preferences(user_id pk, default_buffer_minutes int, created_at, updated_at)`.

Redis/BullMQ queues

- `conflicts`: `conflicts.detect`.

Worker responsibilities

- Detect conflicts for affected time windows on event changes; emit `calendar.conflict.detected` triggers.

API routes

- Keep `GET /api/v1/events/conflicts` for diagnostics; it must not become the primary trigger source.

Edge cases

- Large event volumes require bounding ranges and paging.

Idempotency / retries

- Conflict triggers deduped by stable conflict identity (sorted event IDs + time window bucket).

### Step 14 — Add Microsoft Graph calendar integration (subscriptions + delta sync)

Goal

- Implement connect flow, Graph subscriptions, and delta sync.

Why now

- Microsoft is a mandatory integration.

Files to create

- `src/services/calendar/microsoftGraph.client.ts`
- `src/services/calendar/microsoftSubscriptions.service.ts`
- `src/services/calendar/microsoftSync.service.ts`
- Extend `src/routes/auth.routes.ts` or add `src/routes/auth.microsoft.routes.ts`.
- Extend `src/routes/calendar.routes.ts` or add Microsoft webhook routes.

Files to modify

- `src/services/auth.service.ts`: add refresh path for Microsoft tokens.

Database changes

- `014_microsoft_subscriptions.sql`: `microsoft_subscriptions(user_id, subscription_id unique, resource, expiration, delta_link, client_state, created_at, updated_at)`.

Redis/BullMQ queues

- `calendar-sync`: `calendar.microsoft.sync`, `calendar.microsoft.subscription.renew`.

Worker responsibilities

- Renew subscriptions; run delta sync; handle invalid delta links.

API routes

- Microsoft webhook endpoint must validate `client_state` and accept Graph validation challenges.

Edge cases

- Graph sends a validation handshake; webhook must echo `validationToken`.

Idempotency / retries

- Dedupe sync jobs by `(subscription_id, delta_cursor_hash)`.

### Step 15 — Implement AI service abstraction for JSON-only generation

Goal

- Add LLM provider behind a single interface with strict JSON schema enforcement.

Why now

- Workflow step `ai_generate_email` requires deterministic validation and safe fallback.

Files to create

- `src/services/ai/provider.ts`
- `src/services/ai/schemas.ts`
- `src/services/ai/prompts/*.ts`
- `src/services/ai/ai.service.ts`

Files to modify

- `src/workflow/registry.ts`: register `ai_generate_email` step.

Database changes

- Persist outputs to `ai_outputs`.

Redis/BullMQ queues

- `workflow` queue runs AI step; optional separate `ai` queue is not required.

Worker responsibilities

- Enforce JSON-only responses; validate with Zod; on failure produce deterministic fallback output and persist audit.

API routes

- N/A (AI called only from workers).

Edge cases

- Provider timeouts and rate limits.

Idempotency / retries

- AI step idempotency key: `ai:email_draft:<executionId>:<stepId>:<inputHash>`.

### Step 16 — Implement email draft creation (Gmail + Outlook)

Goal

- Create drafts only; never send automatically.

Why now

- Email is a side effect requiring explicit approval.

Files to create

- `src/services/email/gmail.service.ts`
- `src/services/email/outlook.service.ts`
- `src/services/email/email.service.ts`

Files to modify

- `src/workflow/registry.ts`: register `email_send` step as “draft create”.

Database changes

- Audit log entries on draft creation.

Redis/BullMQ queues

- `email`: `email.draft.create` (optional) or run directly in workflow worker.

Worker responsibilities

- Execute draft creation idempotently and persist draft identifiers.

API routes

- N/A.

Edge cases

- Provider auth failure → mark connected account as reauth required.

Idempotency / retries

- Draft creation idempotency key derived from `(executionId, stepId, recipient, subjectHash)`.

### Step 17 — Implement notification system and signed deep links

Goal

- Deliver actionable notifications and resume workflows.

Why now

- Workflows require user interaction without blocking.

Files to create

- `src/security/signedActions.ts` (HMAC signing + nonce)
- `src/services/notifications/notification.service.ts`
- `src/services/notifications/push.service.ts`
- `src/services/notifications/emailFallback.service.ts`
- `src/routes/workflow.actions.routes.ts`

Files to modify

- `src/app.ts`: mount workflow action routes.
- `src/workflow/registry.ts`: implement `notify` step.

Database changes

- Optional: `notification_deliveries` table if delivery receipts are required.

Redis/BullMQ queues

- `notifications`: `notification.send`.

Worker responsibilities

- Send push; on failure, send email fallback; record audit.

API routes

- `POST /api/v1/workflows/actions` (or dedicated `/api/v1/workflows/actions`) must verify signed tokens and enqueue resume.

Edge cases

- Signed token replay: nonce single-use.

Idempotency / retries

- Notification job `jobId` derived from `(executionId, stepId, actionSetHash)`.

### Step 18 — Add audit logging and structured logging across API and workers

Goal

- Make every side effect auditable and every request/job traceable.

Why now

- Required for safe retries and production operations.

Files to create

- `src/observability/logger.ts`
- `src/middleware/requestId.ts`
- `src/services/audit.service.ts`

Files to modify

- All side-effecting services (calendar mutation, email, notifications, AI) must write audit entries.

Database changes

- Uses `audit_log` from Step 2.

Redis/BullMQ queues

- N/A.

Worker responsibilities

- Include `requestId`/`jobId`/`executionId` in log context.

API routes

- N/A.

Edge cases

- Do not log secrets or tokens.

Idempotency / retries

- Audit writes are idempotent by `(action, idempotency_key)`.

### Step 19 — Implement rate limiting and abuse prevention

Goal

- Protect externally exposed routes (OAuth, webhooks, workflow actions).

Why now

- These endpoints will be targeted; without rate limiting, Redis/DB and providers will be overwhelmed.

Files to create

- `src/middleware/rateLimit.ts` (Redis token bucket)

Files to modify

- Apply to:
  - OAuth connect/callback routes
  - webhook routes
  - workflow action routes

Database changes

- N/A.

Redis/BullMQ queues

- N/A.

Worker responsibilities

- N/A.

API routes

- N/A.

Edge cases

- Webhook sources may share IPs; rate limits must include provider-specific allowlisting where needed.

Idempotency / retries

- N/A.

### Step 20 — Replace remote Supabase auth introspection with local JWT verification

Goal

- Verify Supabase JWTs locally using cached JWKS and avoid per-request upstream dependency.

Why now

- Removes a hard dependency on Supabase availability and reduces latency.

Files to create

- `src/security/supabaseJwt.ts` (JWKS fetch + cache + `verifyJwt()`)

Files to modify

- `src/middleware/auth.ts`: verify locally, then upsert user.

Database changes

- N/A.

Redis/BullMQ queues

- N/A.

Worker responsibilities

- N/A.

API routes

- N/A.

Edge cases

- Key rotation: JWKS cache must refresh on `kid` mismatch.

Idempotency / retries

- N/A.

---

## 4) Worker Architecture Plan

### 4.1 Queues

Create BullMQ queues (each with its own concurrency and retry policy):

- `calendar-sync`
  - `calendar.google.sync`
  - `calendar.google.watch.renew`
  - `calendar.microsoft.sync`
  - `calendar.microsoft.subscription.renew`
- `triggers`
  - `trigger.emit`
  - `trigger.evaluate`
- `workflow`
  - `workflow.run`
  - `workflow.resume`
  - `workflow.timeout`
- `conflicts`
  - `conflicts.detect`
- `notifications`
  - `notification.send`
- `email`
  - `email.draft.create`
- `dlq`
  - Receives jobs after permanent failure (manual inspection + replay tooling)

### 4.2 Job envelope schema (mandatory)

All jobs must carry a standard envelope:

```json
{
  "jobType": "workflow.run",
  "requestId": "uuid",
  "idempotencyKey": "string",
  "userId": "uuid",
  "payload": {}
}
```

Enforcement

- Zod-validate in producers and processors; reject invalid jobs.

### 4.3 Retry policies

- `calendar.*.sync`
  - attempts: 8
  - backoff: exponential (base 30s, max 30m)
  - treat 4xx (auth) as non-retryable; mark as failed with “reauth required” state.
- `workflow.*`
  - attempts: 12
  - backoff: exponential (base 5s, max 15m)
  - step handler must record attempt number in `workflow_execution_steps`.
- `ai.generate_email`
  - attempts: 3
  - backoff: fixed 60s
  - non-retryable on schema-validation failure (fallback template).

### 4.4 Deduplication strategy

- Use BullMQ `jobId` as the primary dedupe mechanism.
- Derive `jobId` from a deterministic key:
  - Example: `workflow:run:<executionId>:<stepId>:<attempt>`
  - Example: `google:sync:<channelId>:<syncTokenHash|full>`

Additionally

- Use Redis `SET NX` for short-window coalescing (e.g., 30–120 seconds) on webhook bursts.

### 4.5 Failure handling and DLQ

- Classify failures
  - transient: network, 5xx, rate limits → retry
  - permanent: invalid credentials, invalid definition, missing resources → fail fast
- On permanent failure
  - write `workflow_executions.status = failed` (or equivalent for non-workflow jobs)
  - write `audit_log` entry
  - enqueue a DLQ job with the full job context for inspection

---

## 5) Workflow Engine Completion Plan

### 5.1 Execution state machine

Execution (`workflow_executions.status`)

- `pending` → `running` → (`waiting` | `completed` | `failed`)
- `waiting` → `running` on `workflow.resume`

Step (`workflow_execution_steps.status`)

- `pending` → `running` → (`waiting` | `completed` | `failed`)

State transitions

- Must be persisted with `updated_at` and optimistic concurrency (compare-and-swap) to prevent double runners.

### 5.2 Step execution rules (idempotency contract)

For every step handler:

- Inputs
  - `execution.context` (immutable snapshot for the step run)
  - `stepDefinition`
  - `attempt`
- Outputs
  - `output jsonb` (persisted)
  - `nextStepId` or `waitSpec`

Idempotency

- Every step must compute an `effectIdempotencyKey` and pass it to any side-effecting service (email, calendar mutation, notification).
- The engine must refuse to execute a step if a completed step row already exists for `(execution_id, step_id)`.

### 5.3 Step registry structure

- `src/workflow/registry.ts`
  - `registerStep(type, handler)`
- `src/workflow/steps/*.ts`
  - One file per step type.

Handlers must be pure where possible; side effects must be called via services that enforce idempotency + audit.

### 5.4 Context persistence rules

- `execution.context` is a JSON document.
- Context updates must be append-only semantics:
  - write outputs into `context.outputs[stepId]`.
  - never delete keys; deprecate with versioning if needed.
- Store a per-step input snapshot in `workflow_execution_steps.input`.

### 5.5 Branching logic

- Branch step defines `routes: { [routeKey]: nextStepId }`.
- Route selection is deterministic and based on:
  - user action payload (from signed deep link)
  - or a condition evaluation (deterministic, non-AI)

### 5.6 Timeout handling

- `wait_until`: engine enqueues `workflow.resume` with delay.
- `wait_for_input`: engine sets `waiting` with `next_run_at` and enqueues a `workflow.timeout` job.
- On timeout job
  - validate execution is still waiting on the same step
  - take a deterministic default route or fail the execution (definition-controlled)

### 5.7 User interaction handling

- Notifications include action tokens signed with HMAC secret.
- `POST /api/v1/workflows/actions`
  - verifies signature, validates token expiry, writes an audit log
  - enqueues `workflow.resume` with `{ executionId, stepId, actionKey, payload }`

No synchronous waiting. No in-memory state.

### 5.8 Event-driven triggers

- Trigger types are strings: `calendar.event.upserted`, `calendar.event.deleted`, `calendar.conflict.detected`, etc.
- Trigger evaluation
  - load active workflows by `trigger_type`
  - evaluate deterministic `conditions[]`
  - start an execution by inserting `workflow_executions` + first step row
  - enqueue `workflow.run`

---

## 6) Calendar Sync Completion Plan

### 6.1 OAuth token storage strategy

- Store encrypted tokens in Postgres (AES-GCM, application-level).
- Keep `expires_at` in plaintext for scheduling refresh/renewal.
- Support key rotation via `enc_kid`.

### 6.2 Refresh token handling

- Always use refresh token to obtain access tokens.
- On refresh failure:
  - mark connected account as `reauth_required` (add column) and stop retrying
  - notify user via workflow/notification.

### 6.3 Webhook verification (Google)

- Validate required headers:
  - `x-goog-channel-id`
  - `x-goog-resource-id`
  - `x-goog-resource-state`
- Look up `google_watch_channels` by `channel_id`.
- Verify `resource_id` matches stored value.
- Use short-window dedupe on `(channel_id, resource_state)` to coalesce bursts.
- Immediately respond 200; enqueue work.

### 6.4 Normalization pipeline

- Provider raw → `NormalizedEvent` using deterministic mapping.
- Classification via `event_type_rules` only.
- For cancels/deletes
  - represent as `event.deleted` trigger
  - either hard-delete from `events` or set a `deleted_at` flag (choose one and keep consistent across providers).

### 6.5 Snapshot creation

- Current snapshot logic is UPDATE-only via `xmax`.
- Required improvement
  - snapshot on INSERT and UPDATE (audit must include the full timeline)
  - include raw provider payload hash in snapshot metadata to detect duplicates.

### 6.6 Conflict trigger invocation

- On event upsert/delete
  - enqueue `conflicts.detect` for affected time range (event start/end ± buffer)
  - emit conflict triggers on changes (new conflict, cleared conflict).

### 6.7 Recurring event handling

Google

- `events.list(singleEvents=true)` expands occurrences but loses series-level semantics.
- Production plan
  - store `series_id` (Google `recurringEventId` or iCal UID) and `occurrence_id`.
  - treat exception instances as separate external IDs.
  - conflict engine uses occurrence instances.

<!-- skip microsoft for now -->

Microsoft

- Use Graph expanded instances or delta queries with series identifiers.

Determinism

- All recurrence expansion must be handled by provider APIs; do not implement recurrence math in-house.

---

## 7) Conflict Engine Plan

### 7.1 Overlap detection

Base predicate

- Two events conflict when: `A.start < B.end AND A.end > B.start`.

SQL stage

- Produce candidate pairs by time overlap within a bounded range.

### 7.2 Buffer handling

- Each user has `default_buffer_minutes`.
- Effective interval is expanded:
  - `A.start' = A.start - buffer`
  - `A.end'   = A.end + buffer`
- Buffer violation conflicts use `conflictType = buffer_violation`.

### 7.3 Recurring exceptions

- Work strictly on occurrence instances.
- Ensure cancelled instances are not considered.

### 7.4 Organizer priority logic

Deterministic scoring factors (example)

- If user is organizer of one event and not the other, increase severity for conflict affecting organized event.
- If the conflicting event organizer is in user’s priority list (optional future preference table), increase severity.

### 7.5 Required vs optional attendees

- Required attendee = attendee exists with `optional != true`.
- Optional-only events should not automatically be low severity if user is organizer.

### 7.6 Severity scoring

Define a numeric score mapped to tiers:

- base overlap minutes
- - organizer weight
- - required attendees weight
- - meeting type weight (if provided by rule-driven event type)

Persist

- Store computed conflicts in a `conflicts` table if downstream workflows need stable IDs and change tracking.

### 7.7 Trigger format for workflow engine

Canonical trigger payload:

```json
{
  "trigger": "calendar.conflict.detected",
  "userId": "uuid",
  "conflict": {
    "conflictingEvents": ["eventIdA", "eventIdB"],
    "conflictType": "overlap",
    "severity": "high",
    "overlapMinutes": 25
  },
  "observedAt": "iso"
}
```

No AI.

---

## 8) AI Integration Plan

### 8.1 Strict JSON schema enforcement

- All AI outputs must be parsed as JSON and validated using Zod.
- Reject outputs that are not valid JSON.

Email draft schema (example)

- `subject: string`
- `body: string`
- `reason: string`
- `proposed_times: string[]`

### 8.2 Validation layer

- Validation happens in `ai.service.ts`.
- Only validated outputs are persisted into `ai_outputs`.

### 8.3 Fallback template strategy

- Deterministic template renderer that uses event + conflict context.
- Used when:
  - provider times out
  - rate limited
  - schema invalid

### 8.4 Logging and auditing

- Log request ID, execution ID, model/provider, latency, and validation outcome.
- Write an `audit_log` entry for AI generation (even on fallback).

### 8.5 Rate limiting

- Redis token bucket per user and per IP (if exposed).
- Hard ceiling to prevent cost blowups.

### 8.6 Prompt design strategy

- Single-pass prompts.
- Explicit instruction: “Return JSON only. No prose.”
- Provide a JSON schema and minimal context fields.
- Never include secrets.

No agent loops.

---

## 9) Notification System Plan

### 9.1 Push notification structure

```json
{
  "title": "Meeting Conflict",
  "body": "Two events overlap.",
  "actions": [
    { "label": "Keep A", "actionKey": "keep_event_a", "token": "signed" },
    { "label": "Keep B", "actionKey": "keep_event_b", "token": "signed" }
  ]
}
```

### 9.2 Signed deep link strategy

- Signed token includes:
  - `executionId`, `stepId`, `actionKey`, `exp`, `nonce`
- Sign with HMAC secret `ACTION_SIGNING_SECRET`.
- Validate:
  - signature
  - expiry
  - nonce (Redis `SET NX`) to prevent replay

### 9.3 User action → workflow resume

- API endpoint validates and enqueues `workflow.resume`.
- Workflow engine loads execution and continues deterministically.

### 9.4 Email fallback

- If push credentials missing or delivery fails, send an email with the same action links.

---

## 10) Security Plan

### 10.1 Token encryption

- Application-layer AES-256-GCM.
- Key material provided via env vars.
- Rotation supported via `enc_kid`.

### 10.2 OAuth scopes

- Google Calendar scopes must be least-privilege.
- Gmail scopes only when email draft feature is enabled.
- Microsoft Graph scopes similarly constrained.

### 10.3 Rate limiting

- Redis-backed.
- Separate buckets for:
  - OAuth endpoints
  - webhooks
  - AI generation

### 10.4 Audit logging

- Every side effect writes:
  - action name
  - entity
  - idempotency key
  - request/job identifiers

### 10.5 Idempotency keys

- Mutating endpoints require `Idempotency-Key`.
- Workers compute effect idempotency keys and record them.

### 10.6 Replay protection

- OAuth state stored server-side, single-use.
- Webhooks coalesced and deduped.
- Signed action nonces single-use.

---

## 11) Horizontal Scaling Plan

### 11.1 Stateless API design

- API servers must not hold workflow state.
- All state is persisted in Postgres or Redis.

### 11.2 Worker scaling strategy

- Scale workers horizontally by queue.
- Concurrency configured per processor.
- Ensure each job type has deterministic dedupe and idempotent handlers.

### 11.3 Redis usage boundaries

Redis is for

- BullMQ transport
- short-lived dedupe keys
- rate limiting
- OAuth state storage

Redis is not for

- durable workflow execution state
- long-term audit history

### 11.4 DB transaction isolation strategy

- Use transactions for:
  - workflow step state transitions
  - audit + side effect record writes
- Use optimistic concurrency on executions to prevent concurrent runners.

---

## 12) What MUST NOT Be Done

Anti-patterns (explicitly forbidden)

- Hard-coded event type logic (title heuristics) in code.
- AI deciding workflow routes or executing side effects.
- Sending emails without user preview/approval.
- Polling calendars in a loop to detect changes.
- Running workflow state machines in memory (must persist to DB).
- Non-idempotent workers (no dedupe keys, no audit).
- Webhook handlers doing heavy work synchronously.
- Storing provider bearer tokens in plaintext.
- Using OAuth `state` to transport bearer credentials.
