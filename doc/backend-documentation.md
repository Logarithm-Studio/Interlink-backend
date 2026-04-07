# Backend Documentation

## 1. Environment Configuration (`src/server.ts`, `.env`)

All runtime configuration comes from environment variables loaded via `dotenv` at process startup. Variables live in `.env` (local, gitignored) and `.env.example` (reference template committed to the repo). Do **not** commit secrets.

### 1.1 Overview

`src/server.ts` validates the following variables before starting and will `process.exit(1)` if any required one is missing:

```
DATABASE_URL   SUPABASE_URL   SUPABASE_KEY   REDIS_URL   ENCRYPTION_KEY
```

All other variables are optional at startup but required when their feature is exercised at runtime.

### 1.2 Variable Reference

**Server**

| Variable | Required | Default | Purpose                               |
| -------- | -------- | ------- | ------------------------------------- |
| `PORT`   | No       | `5000`  | HTTP listen port for the Express API. |

**Database**

| Variable       | Required | Purpose                                                                                                                                                 |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | Yes      | PostgreSQL connection string (Supabase-hosted). Format: `postgresql://user:password@host:5432/db`. URL-encode special chars in passwords (`@` → `%40`). |

**Supabase Auth**

| Variable       | Required | Purpose                                                                                                                                    |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_URL` | Yes      | Supabase project base URL. Used to construct the JWKS endpoint `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` for local JWT verification. |
| `SUPABASE_KEY` | Yes      | Supabase anon/service-role key. Used to initialise the Supabase JS client in `src/config/supabase.ts`.                                     |

**Google OAuth**

| Variable               | Required              | Purpose                                                                                                                                           |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Yes (Google features) | OAuth 2.0 client ID for Google Calendar and Gmail scopes.                                                                                         |
| `GOOGLE_CLIENT_SECRET` | Yes (Google features) | OAuth 2.0 client secret.                                                                                                                          |
| `GOOGLE_REDIRECT_URI`  | No                    | Defaults to `http://localhost:5000/api/v1/auth/callback/google`. Must match the value registered in the Google Cloud console.                     |
| `GOOGLE_WEBHOOK_URL`   | Yes (push channels)   | Public HTTPS URL where Google sends Calendar push notifications. Must be reachable from the internet; use ngrok or a tunnel in local development. |

**Microsoft OAuth** _(not yet implemented)_

| Variable                  | Required    | Purpose                                          |
| ------------------------- | ----------- | ------------------------------------------------ |
| `MICROSOFT_CLIENT_ID`     | Placeholder | Reserved for future Microsoft Graph integration. |
| `MICROSOFT_CLIENT_SECRET` | Placeholder | Reserved for future Microsoft Graph integration. |

**Redis**

| Variable    | Required | Purpose                                                                                                                                                    |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL` | Yes      | Redis connection string. Local dev: `redis://127.0.0.1:6379`. Upstash: `rediss://default:<token>@<host>:6379` (TLS auto-detected from `rediss://` prefix). |

**Encryption**

| Variable                                  | Required | Purpose                                                                                                                |
| ----------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`                          | Yes      | 64 hex chars (32 bytes) primary AES-256-GCM key for provider token encryption. Registered as `kid="1"` in the keyring. |
| `ENCRYPTION_KEY_2`, `ENCRYPTION_KEY_3`, … | No       | Rotation keys. Add a new one, deploy, backfill data, then remove old key.                                              |

**Signed Workflow Actions**

| Variable                | Required               | Purpose                                                                                                                                  |
| ----------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTION_SIGNING_SECRET` | Yes (workflow actions) | 64 hex chars (32 bytes) used to HMAC-SHA256-sign workflow resume tokens embedded in notifications. Absence throws at token signing time. |

**AI**

| Variable                          | Required          | Default  | Purpose                                                                              |
| --------------------------------- | ----------------- | -------- | ------------------------------------------------------------------------------------ |
| `AI_PROVIDER`                     | No                | `demo`   | `openai` or `demo`. `demo` returns plausible hard-coded drafts with no API call.     |
| `AI_API_KEY`                      | Yes (if `openai`) | —        | API key for the configured AI provider.                                              |
| `AI_MODEL`                        | No                | `gpt-4o` | Model name passed to the provider (e.g., `gpt-4o`, `gpt-3.5-turbo`).                 |
| `AI_RATE_LIMIT_PER_USER_PER_HOUR` | No                | `10`     | Max AI draft generation calls per user per rolling hour. Enforced via Redis counter. |

**Firebase / FCM**

| Variable                       | Required | Purpose                                                                                                            |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `FIREBASE_PROJECT_ID`          | No       | FCM project ID. If absent, push notifications are skipped and email fallback is used automatically.                |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | No       | Single-line JSON service-account key for Firebase Admin / FCM HTTP v1. Required when `FIREBASE_PROJECT_ID` is set. |

**Application**

| Variable                           | Required | Purpose                                                                                                                                                       |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_BASE_URL`                     | No       | Base URL for deep links embedded in notification email drafts (e.g., `https://app.interlink.io`).                                                             |
| `LOG_LEVEL`                        | No       | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Defaults to `info`.                                                                       |
| `RATE_LIMIT_WEBHOOK_ALLOWLIST_IPS` | No       | Comma-separated IP addresses or CIDR prefixes that bypass the Google webhook rate limiter. Supports exact IPs and prefix matches (e.g., `34.64.`, `66.249.`). |

### 1.3 Local Redis Setup

```bash
# Start a local Redis container
docker run --name interlink-redis -p 6379:6379 redis:7-alpine

# Set env var
REDIS_URL=redis://127.0.0.1:6379
```

Restart both the API server and the worker process after changing `REDIS_URL`.

### 1.4 Key Rotation Procedure

1. Generate new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Add as `ENCRYPTION_KEY_2` (or next sequence number) to `.env`.
3. Deploy — new writes use the highest-registered active key.
4. Run a backfill job to re-encrypt existing rows with the new key.
5. Remove the old `ENCRYPTION_KEY` variable once all rows are migrated.

### 1.5 Operational Notes

- Never commit `.env`; use `.env.example` for variable names only.
- Google webhook requires a reachable HTTPS URL — use ngrok (`ngrok http 5000`) in local development and update `GOOGLE_WEBHOOK_URL` in `.env`.
- Microsoft OAuth variables exist as placeholders; the Graph integration is not yet implemented.
- If the Upstash free tier (10,000 commands/day) is exceeded, switch to local Docker Redis.

## 2. Database Migrations and Tables (`src/db`)

All schema changes are SQL migration files applied in order by a custom runner. Tables follow a multi-tenant pattern where every row is scoped to a `user_id` foreign key.

### 2.1 Overview

- **Migration folder**: [src/db/migrations/](src/db/migrations/) — numbered `*.sql` files applied in ascending order.
- **Runner**: [src/db/migrations/runner.ts](src/db/migrations/runner.ts) — reads the `migrations/` directory, tracks applied files in a `schema_migrations` table, and runs pending files inside a transaction.
- **Convention**: filenames are `NNN_description.sql` (e.g., `001_users.sql`). Never edit an applied migration; add a new one.

### 2.2 Table Reference

| Table                      | Key Columns                                                                                                                                                                         | Purpose                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `users`                    | `id` (UUID, PK), `email`, `timezone`, `created_at`                                                                                                                                  | Core user record. Inserted/upserted on every authenticated request via `authMiddleware`.                               |
| `connected_accounts`       | `(user_id, provider)` UNIQUE, `access_token_enc`, `refresh_token_enc`, encryption metadata, `expires_at`, `reauth_required`                                                         | Per-user OAuth credentials. Tokens are stored AES-256-GCM encrypted; see `src/security/crypto.ts`.                     |
| `events`                   | `(user_id, external_event_id, provider)` UNIQUE, `event_type`, `title`, `start_time`, `end_time`, `attendees` JSONB, `is_recurring`, `series_id`, `occurrence_id`, `metadata` JSONB | Normalised calendar events (provider-agnostic). Upserted on every sync.                                                |
| `event_snapshots`          | `event_id` FK, `snapshot` JSONB, `created_at`                                                                                                                                       | Immutable history of event state at each write. Used for audit trails and future change-detection workflows.           |
| `workflows`                | `id`, `name`, `trigger_type`, `definition` JSONB, `is_active`                                                                                                                       | User workflow definitions. `definition` is validated against `WorkflowDefinitionSchema` on read.                       |
| `workflow_executions`      | `id`, `workflow_id` FK, `user_id` FK, `status`, `context` JSONB, `current_step`                                                                                                     | One row per workflow run. `context` carries trigger payload and step outputs.                                          |
| `workflow_execution_steps` | `(execution_id, step_id)` UNIQUE, `status`, `attempt`, `input`/`output`/`error` JSONB, `started_at`, `finished_at`, `next_run_at`                                                   | Per-step state machine. Enables idempotent re-entry on BullMQ retries.                                                 |
| `jobs`                     | `id`, `queue`, `job_type`, `idempotency_key` UNIQUE, `status`                                                                                                                       | Lightweight ledger for enqueued background jobs. Ties to BullMQ job IDs.                                               |
| `ai_outputs`               | `id`, `user_id` FK, `execution_id`, `idempotency_key` UNIQUE, `model`, `content` JSONB, `latency_ms`, `is_fallback`                                                                 | Persisted AI generation results. Deduped by `idempotency_key`; fallback results are flagged.                           |
| `audit_log`                | `id`, `actor_type`, `action`, `entity_type`, `entity_id`, `idempotency_key`, `(action, idempotency_key)` UNIQUE, `payload` JSONB                                                    | Durable audit trail. `ON CONFLICT DO NOTHING` on the unique key makes writes idempotent.                               |
| `google_watch_channels`    | `channel_id` PK, `user_id` FK, `resource_id`, `channel_token`, `calendar_id`, `sync_token`, `expiration`                                                                            | Active Google Calendar push channels. Used to validate incoming webhook notifications and drive incremental sync.      |
| `event_type_rules`         | `priority`, `rule` JSONB (`conditions[]`, `match`), `event_type`, `is_active`, `user_id` nullable, `provider` nullable                                                              | Data-driven event classification rules. Lower `priority` number = evaluated first; first match wins.                   |
| `user_preferences`         | `user_id` PK FK, `default_buffer_minutes`, `tone_preference`, `notify_via`, `timezone`                                                                                              | Per-user scheduling and notification preferences. Upserted with defaults on first read.                                |
| `email_drafts`             | `id`, `user_id`, `provider`, `idempotency_key` UNIQUE, `provider_draft_id`, `sent_at`, `thread_id`                                                                                  | Tracks Gmail (and future Outlook) drafts created by the workflow engine. Prevents duplicate draft creation on retries. |
| `notification_deliveries`  | `id`, `user_id`, `execution_id`, `step_id`, `title`, `channel` (`push`/`email`), `status`, `delivered_at`                                                                           | Records every push and email delivery attempt for observability and idempotency.                                       |
| `push_tokens`              | `(user_id, token)` UNIQUE, `platform` (`ios`/`android`/`web`)                                                                                                                       | FCM device tokens registered by client apps. Used by the push notification service.                                    |
| `conflicts`                | `(user_id, event_a_id, event_b_id)` UNIQUE (ordered), `conflict_type`, `severity`, `overlap_minutes`, `status` (`active`/`cleared`)                                                 | Detected calendar conflicts. Canonical pair ordering (event_a_id < event_b_id) prevents duplicates.                    |

### 2.3 Key Migration Notes

| Migration File                      | Change                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `015_ai_outputs_idempotency.sql`    | Adds `idempotency_key UNIQUE` to `ai_outputs`.                                         |
| `018_events_recurrence.sql`         | Adds `series_id` and `occurrence_id` columns to `events` for recurring event tracking. |
| `019_conflicts.sql`                 | Introduces `conflicts` table with canonical pair ordering and a uniqueness constraint. |
| `020_email_drafts_send_columns.sql` | Adds `sent_at`, `thread_id`, `provider_message_id` to `email_drafts`.                  |
| `021_seed_conflict_workflow.sql`    | Seeds a default active workflow definition for conflict resolution.                    |
| `022_user_preferences_expand.sql`   | Expands `user_preferences` with additional notification and timezone fields.           |

### 2.4 Conventions

- Every user-scoped table has `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`.
- All PKs are `UUID DEFAULT gen_random_uuid()`.
- Timestamps are `TIMESTAMPTZ` in UTC.
- JSONB columns default to `'{}'::jsonb` or `'[]'::jsonb`.
- Uniqueness on mutable entities uses `ON CONFLICT ... DO UPDATE` (upsert pattern) — never hard delete + re-insert.

## 3. Auth Middleware (`src/middleware/auth.ts`)

The auth middleware is the central gatekeeper for all protected Express routes. It performs local JWT verification, upserts the user record, and attaches a typed `req.user` object for downstream route handlers.

### 3.1 Overview

Every protected route passes through `authMiddleware` before reaching its handler. The middleware:

1. Extracts the JWT from the `Authorization: Bearer <token>` header.
2. Verifies the token signature locally using cached JWKS — no round-trip to Supabase.
3. Upserts the user into the `users` table (creates on first login, updates email on subsequent logins).
4. Attaches `req.user = { id, email }` for downstream use.

**File**: [src/middleware/auth.ts](src/middleware/auth.ts)

### 3.2 Function Signature

```typescript
async function authMiddleware(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void>;
```

### 3.3 Behavior

1. Read `Authorization` header; if absent or not `Bearer <token>`, throw `UnauthorizedError("Missing or malformed Authorization header")`.
2. Split the header to extract the raw JWT string.
3. Call `verifyJwt(token)` from `src/security/supabaseJwt.ts` (JWKS-based local verification). Throws `UnauthorizedError("Invalid or expired token")` on failure.
4. Execute an upsert: `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`. This keeps the email column fresh if the user updates their Supabase email.
5. Set `req.user = { id: userId, email }`.
6. Call `next()`.

### 3.4 Failure Modes

| Condition                                             | Error Thrown                                                     | HTTP Status |
| ----------------------------------------------------- | ---------------------------------------------------------------- | ----------- |
| `Authorization` header missing or not `Bearer`        | `UnauthorizedError("Missing or malformed Authorization header")` | 401         |
| JWT signature invalid, expired, wrong issuer/audience | `UnauthorizedError("Invalid or expired token")`                  | 401         |
| Database upsert fails                                 | Unhandled DB error → caught by global `errorHandler`             | 500         |

### 3.5 Key Design Decisions

- **No per-request Supabase call**: JWKS is fetched once and cached for 1 hour by `jose`'s `createRemoteJWKSet`. Key rotation is handled transparently via a single retry on `kid` mismatch.
- **Upsert on every request**: This is intentional — it is cheap (indexed PK conflict) and ensures the user row always exists when downstream handlers assume `user_id` is present in the DB.
- **Usage**: attach at router level (`router.use(authMiddleware as never)`) or per-route.

### 3.6 Example

```typescript
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";

router.get("/me", authMiddleware as never, (req: Request, res: Response) => {
  const user = (req as AuthenticatedRequest).user;
  res.json({ id: user.id, email: user.email });
});
```

## 4. Queues (`src/queues`)

The queues module exposes seven named BullMQ queues backed by a shared Redis connection. All queues are lazily instantiated — their getter functions create the `Queue` object on first call, ensuring `getConnection()` is only invoked after `dotenv.config()` has run at server startup.

### 4.1 Overview

- **File**: [src/queues/queues.ts](src/queues/queues.ts)
- **Connection source**: [src/queues/connection.ts](src/queues/connection.ts) — provides `getConnection(): RedisOptions` (see Section 21.2.1).
- **Pattern**: each queue has a dedicated getter function. The queue module never enqueues jobs directly; calling code (routes, services, workers) calls the getter and then `queue.add(...)`.

### 4.2 Queue Reference

| Queue Name      | Getter                    | Primary Job Types                                     | Purpose                                                                                                    |
| --------------- | ------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `calendar-sync` | `getCalendarSyncQueue()`  | `google.sync`, `google.watch.renew`                   | Google Calendar webhook-driven sync and watch-channel renewal. Microsoft stubs reserved (not implemented). |
| `triggers`      | `getTriggersQueue()`      | `trigger.emit`, `trigger.evaluate`                    | Fan out calendar/conflict events to matching workflows and evaluate conditions.                            |
| `workflow`      | `getWorkflowQueue()`      | `workflow.run`, `workflow.resume`, `workflow.timeout` | Execute, resume, and timeout workflow step executions.                                                     |
| `conflicts`     | `getConflictsQueue()`     | `conflicts.detect`                                    | Run the two-stage conflict detection pipeline for a user.                                                  |
| `notifications` | `getNotificationsQueue()` | `notification.send`                                   | Deliver push notifications (FCM) with email fallback.                                                      |
| `email`         | `getEmailQueue()`         | `email.draft.create`                                  | Create Gmail drafts. Never sends automatically.                                                            |
| `dlq`           | `getDlqQueue()`           | all (dead-letter)                                     | Receives jobs from any queue after all retries are exhausted.                                              |

### 4.3 Key Exports

```typescript
function getCalendarSyncQueue(): Queue; // calendar-sync queue
function getTriggersQueue(): Queue; // triggers queue
function getWorkflowQueue(): Queue; // workflow queue
function getConflictsQueue(): Queue; // conflicts queue
function getNotificationsQueue(): Queue; // notifications queue
function getEmailQueue(): Queue; // email queue
function getDlqQueue(): Queue; // dead-letter queue

function getAllQueues(): Queue[];
// Returns all seven queues — used at startup for health checks and graceful shutdown.
```

### 4.4 Example Usage

**Enqueueing a job** (from a route or service):

```typescript
import { getWorkflowQueue } from "../queues/queues";
import { JobType } from "../jobs/schemas/envelope";

await getWorkflowQueue().add(
  JobType.WORKFLOW_RUN,
  {
    jobType: JobType.WORKFLOW_RUN,
    requestId: randomUUID(),
    idempotencyKey: `workflow|run|${executionId}|${stepId}`,
    userId: user.id,
    payload: { executionId, stepId, attempt: 0 },
  },
  {
    jobId: `workflow|run|${executionId}|${stepId}`, // deterministic — deduplicates retries
    attempts: 12,
    backoff: { type: "exponential", delay: 5_000 },
  },
);
```

**Accessing queues for cleanup** (graceful shutdown / tests):

```typescript
import { getAllQueues } from "../queues/queues";
await Promise.all(getAllQueues().map((q) => q.close()));
```

### 4.5 Design Notes

- **Lazy init**: getters use the `??=` null-coalescing assignment pattern so that `getConnection()` is called only after env is loaded.
- **Shared connection**: all queues share the same underlying `RedisOptions` object from `getConnection()`. BullMQ internally manages individual connections per queue.
- **No auto-send**: the `email` queue creates drafts only; sending is a separate explicit step in the workflow.

## 5. Auth Routes (`src/routes/auth.routes.ts`)

The auth routes handle Google OAuth consent, the OAuth callback, and the current-user endpoint. All three are rate-limited.

### 5.1 Overview

**File**: [src/routes/auth.routes.ts](src/routes/auth.routes.ts)
**Base path**: `/api/v1/auth`
**Rate limiting**: `oauthRateLimit` applied to all OAuth endpoints (10 req / 15 min per IP).

**Google OAuth scopes requested**:

- `https://www.googleapis.com/auth/calendar` — full Calendar read/write
- `https://www.googleapis.com/auth/gmail.compose` — Gmail draft creation

### 5.2 Endpoints

---

#### `GET /api/v1/auth/google/start`

**Auth required**: Yes (`authMiddleware` — valid Supabase Bearer JWT).

**Purpose**: Returns a Google OAuth authorization URL for mobile/native clients.

**Behavior**:

1. Extract `user.id` from `req.user` (set by `authMiddleware`).
2. Call `createOAuthState(user.id, "google")` — generates a 128-bit random token, stores `{ userId, provider }` in Redis with a 10-minute TTL, returns the token.
3. Build a Google OAuth2 authorization URL with `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, and the opaque state token.
4. Return JSON:

```json
{
  "provider": "google",
  "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "stateTtlSeconds": 600
}
```

---

#### `GET /api/v1/auth/google`

**Auth required**: Yes (`authMiddleware` — valid Supabase Bearer JWT).

**Purpose**: Redirects the authenticated user to Google's OAuth consent screen.

**Behavior**:

1. Extract `user.id` from `req.user` (set by `authMiddleware`).
2. Call `createOAuthState(user.id, "google")` — generates a 128-bit random token, stores `{ userId, provider }` in Redis with a 10-minute TTL, returns the token.
3. Build a Google OAuth2 authorization URL with `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, and the opaque state token.
4. `res.redirect(authUrl)` — the user's browser navigates to Google.

**Security**: The `state` parameter is an opaque random token — it does NOT carry the Supabase JWT. This prevents credential leakage into browser history or server logs.

---

#### `GET /api/v1/auth/callback/google`

**Auth required**: No (Google redirects here with `?code=...&state=...`).

**Purpose**: Exchanges the authorization code for tokens and stores them encrypted.

**Request query params**:

| Param   | Required | Description                                   |
| ------- | -------- | --------------------------------------------- |
| `code`  | Yes      | Google authorization code.                    |
| `state` | Yes      | Opaque state token from `createOAuthState()`. |

**Behavior**:

1. Validate both `code` and `state` are present; throw `BadRequestError` if not.
2. Call `consumeOAuthState(stateToken)` — atomically reads and deletes the Redis key. Returns `null` if expired, invalid, or already consumed. Throws `UnauthorizedError("Invalid, expired, or already-used OAuth state token")` on failure.
3. Exchange `code` for tokens via `oauth2Client.getToken(code)`. Throws `BadRequestError` if Google doesn't return both `access_token` and `refresh_token`.
4. Call `storeTokens(userId, "google", { accessToken, refreshToken, expiresAt })` — encrypts both tokens with AES-256-GCM and upserts into `connected_accounts`.
5. On success:
  - If `GOOGLE_OAUTH_SUCCESS_REDIRECT_URI` is set, respond with `302` to that URL with query params `provider=google&status=success`.
  - Otherwise return JSON success payload.

6. On callback errors:
  - If `GOOGLE_OAUTH_ERROR_REDIRECT_URI` is set, respond with `302` to that URL with query params `provider=google&status=error&code=<error_code>`.
  - Otherwise pass the error to API error middleware.

---

#### `GET /api/v1/auth/me`

**Auth required**: Yes (`authMiddleware`).

**Purpose**: Returns the user's identity and their connected provider accounts.

**Response**:

```json
{
  "user": { "id": "uuid", "email": "user@example.com" },
  "connectedAccounts": {
    "google": { "connected": true, "expiresAt": "2026-03-04T12:00:00.000Z" }
  }
}
```

`connectedAccounts.google` is `null` if no Google account is connected.

**Behavior**: Calls `getTokens(user.id, "google")` which decrypts the stored access token and returns the `ConnectedAccount` object (or `null`).

### 5.3 Security Summary

- No bearer credential ever appears in a redirect URL or query parameter.
- State tokens are single-use (atomic Redis read+delete) with a 10-minute TTL.
- All provider tokens stored encrypted at rest (AES-256-GCM, see Section 12).

---

## 6. Calendar Routes (`src/routes/calendar.routes.ts`)

The calendar routes handle manual syncs, Google push-channel registration, and the public Google webhook receiver.

### 6.1 Overview

**File**: [src/routes/calendar.routes.ts](src/routes/calendar.routes.ts)
**Base path**: `/api/v1/calendar`

| Endpoint               | Auth | Rate Limit                        | Purpose                                        |
| ---------------------- | ---- | --------------------------------- | ---------------------------------------------- |
| `POST /sync`           | Yes  | —                                 | Manually trigger a full calendar sync.         |
| `POST /watch/google`   | Yes  | —                                 | Register a Google push channel.                |
| `POST /webhook/google` | No   | `webhookRateLimit` (120 req/60 s) | Receive and process Google push notifications. |

### 6.2 Endpoints

---

#### `POST /api/v1/calendar/sync`

**Auth required**: Yes.

**Purpose**: Trigger a calendar sync immediately for the authenticated user.

**Request query params**:

| Param      | Required | Default  | Description                                                            |
| ---------- | -------- | -------- | ---------------------------------------------------------------------- |
| `provider` | No       | `google` | Only `google` is supported. Throws `BadRequestError` for other values. |
| `since`    | No       | —        | Optional ISO-8601 timestamp. Passed to `syncUserCalendar()` as a hint. |

**Behavior**: Calls `syncUserCalendar(userId, provider, since)` from `src/services/calendar/sync.ts`. Returns `{ message, synced, skipped, deleted }` counts.

---

#### `POST /api/v1/calendar/watch/google`

**Auth required**: Yes.

**Purpose**: Register a Google Calendar push notification channel for the current user.

**Request body** (optional):

| Field        | Required | Default   | Description                  |
| ------------ | -------- | --------- | ---------------------------- |
| `calendarId` | No       | `primary` | Google calendar ID to watch. |

**Behavior**: Calls `createWatchChannel(userId, calendarId)` from `googleWatch.service.ts`. Returns `{ channelId, calendarId, expiration }`.

**Requirements**: `GOOGLE_WEBHOOK_URL` must be set and publicly reachable.

---

#### `POST /api/v1/calendar/webhook/google`

**Auth required**: No (public endpoint, validated by channel token).

**Purpose**: Receive Google Calendar push notifications and enqueue incremental sync jobs.

**Request headers** (sent by Google):

| Header                  | Description                                                              |
| ----------------------- | ------------------------------------------------------------------------ |
| `x-goog-channel-id`     | BullMQ dedup key and channel lookup identifier.                          |
| `x-goog-resource-id`    | Identifies the watched calendar resource.                                |
| `x-goog-resource-state` | `sync` (handshake) or `exists`/`not_exists` (change).                    |
| `x-goog-message-number` | Monotonically increasing per-channel message number.                     |
| `x-goog-channel-token`  | Opaque token set at channel creation; verified to prevent spoofed POSTs. |

**Behavior**:

1. Respond `200 OK` immediately (Google requires a < 10s acknowledgment).
2. Skip if `resourceState === "sync"` (initial handshake, no data to sync).
3. Build Redis dedupe key: `webhook:google:<channelId>:<resourceId>:<messageNumber>`. Call `isDuplicate(key, 172_800)` (48-hour TTL). If duplicate, return silently.
4. Look up channel via `getChannelByChannelId(channelId)`. Ignore if unknown (stale channel).
5. Verify `x-goog-channel-token` matches the stored `channel.channelToken`. Ignore mismatches.
6. Verify `x-goog-resource-id` matches `channel.resourceId`. Ignore mismatches.
7. Compute deterministic job ID: `google-sync|<channelId>|<messageNumber>`. This coalesces burst notifications into a single BullMQ job.
8. Enqueue `JobType.GOOGLE_SYNC` on `calendar-sync` queue with the job ID, `attempts: 8`, exponential backoff starting at 30 seconds.

### 6.3 Security and Idempotency

- **Anti-spoofing**: channel token validation prevents arbitrary POSTs from triggering syncs.
- **Burst coalescing**: deterministic job ID means rapid Google retries collapse to a single sync run.
- **48h dedupe TTL**: safely exceeds Google's maximum retry window (~24 h).

---

## 7. Events Routes (`src/routes/events.routes.ts`)

The events routes provide CRUD operations on calendar events and on-demand conflict detection. All endpoints require authentication via a router-level `authMiddleware`.

### 7.1 Overview

**File**: [src/routes/events.routes.ts](src/routes/events.routes.ts)
**Base path**: `/api/v1/events`
**Auth**: All endpoints — router-level `authMiddleware`.

### 7.2 Endpoints

---

#### `GET /api/v1/events`

**Purpose**: List calendar events for the current user.

**Request query params**:

| Param  | Required | Description                                   |
| ------ | -------- | --------------------------------------------- |
| `from` | No       | ISO-8601 lower bound for `start_time` filter. |
| `to`   | No       | ISO-8601 upper bound for `start_time` filter. |

**Response**:

```json
{ "events": [ { ...NormalizedEvent } ], "count": 42 }
```

---

#### `GET /api/v1/events/conflicts`

**Purpose**: Run on-demand conflict detection for the current user.

**Request query params**:

| Param  | Required | Description                      |
| ------ | -------- | -------------------------------- |
| `from` | No       | ISO-8601 detection window start. |
| `to`   | No       | ISO-8601 detection window end.   |

**Response**:

```json
{ "conflicts": [ { ...ConflictResult } ], "count": 3 }
```

**Note**: This is synchronous and on-demand. The background `conflicts` queue also runs conflict detection after every calendar sync/upsert.

---

#### `GET /api/v1/events/:id`

**Purpose**: Fetch a single event by its internal UUID.

**Response**: `{ "event": { ...NormalizedEvent } }`. Returns `404 NotFoundError` if not found.

---

#### `PATCH /api/v1/events/:id/reschedule`

**Purpose**: Reschedule an event — patches Google Calendar and updates the local record.

**Request body**:

| Field         | Required | Description                      |
| ------------- | -------- | -------------------------------- |
| `startTime`   | Yes      | New start time (ISO-8601).       |
| `endTime`     | Yes      | New end time (ISO-8601).         |
| `title`       | No       | Updated title.                   |
| `description` | No       | Updated description.             |
| `calendarId`  | No       | Calendar ID (default `primary`). |

**Behavior**: Calls `rescheduleEventAtProvider(user, eventId, { startTime, endTime, title, description, calendarId })`. Returns `{ message: "Event rescheduled", event: updatedEvent }`.

**Access control**: Only the event organizer can reschedule (enforced in `rescheduleEventAtProvider`).

---

#### `POST /api/v1/events/:id/decline`

**Purpose**: Decline a calendar event.

**Request body** (optional):

| Field        | Required | Default   | Description         |
| ------------ | -------- | --------- | ------------------- |
| `calendarId` | No       | `primary` | Google calendar ID. |

**Behavior**: Calls `declineEventAtProvider(user, eventId, calendarId)`.

- **Organizer**: the event is deleted in Google and removed locally.
- **Attendee**: `responseStatus` is patched to `"declined"` in Google and the event is removed locally.

---

#### `DELETE /api/v1/events/:id`

**Purpose**: Delete an event.

**Behavior**: Calls `deleteEventAtProvider(user, eventId)`. Returns `404 NotFoundError` if the event does not exist or does not belong to the user.

**Note**: If the provider (Google) rejects the delete (e.g., attendee attempting organizer-level delete), the event is still removed from the local DB.

---

## 8. Preferences Routes (`src/routes/preferences.routes.ts`)

The preferences routes expose read/write access to per-user scheduling and notification settings.

### 8.1 Overview

**File**: [src/routes/preferences.routes.ts](src/routes/preferences.routes.ts)
**Base path**: `/api/v1/preferences`
**Auth**: All endpoints — router-level `authMiddleware`.

**Preference fields**:

| Field                  | DB Column                | Allowed Values                                  | Default        | Used By                        |
| ---------------------- | ------------------------ | ----------------------------------------------- | -------------- | ------------------------------ |
| `defaultBufferMinutes` | `default_buffer_minutes` | `0`–`120` (int)                                 | `15`           | Conflict detection buffer.     |
| `tonePreference`       | `tone_preference`        | `professional`, `friendly`, `concise`, `formal` | `professional` | AI email generation prompt.    |
| `notifyVia`            | `notify_via`             | `push`, `email`, `both`                         | `push`         | Notification delivery routing. |
| `timezone`             | `timezone`               | IANA timezone string                            | `null`         | Display and scheduling.        |

### 8.2 Endpoints

---

#### `GET /api/v1/preferences`

**Purpose**: Return the current user's preferences.

**Behavior**:

1. Attempt `INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING` — silently creates a default row on first access.
2. If `DO NOTHING` triggered (row existed), issue a separate `SELECT` to fetch it.
3. Return the preferences object.

**Response**:

```json
{
  "preferences": {
    "defaultBufferMinutes": 15,
    "tonePreference": "professional",
    "notifyVia": "push",
    "timezone": "America/New_York",
    "updatedAt": "2026-03-04T12:00:00.000Z"
  }
}
```

---

#### `PUT /api/v1/preferences`

**Purpose**: Partially update user preferences — only the supplied fields are changed.

**Request body** (Zod-validated, all fields optional):

```typescript
{
  defaultBufferMinutes?: number;   // int, 0–120
  tonePreference?: "professional" | "friendly" | "concise" | "formal";
  notifyVia?: "push" | "email" | "both";
  timezone?: string;               // min 1, max 64 chars
}
```

**Behavior**:

1. Validate with `UpdatePreferencesSchema.safeParse(req.body)`. Throws `BadRequestError` on failure.
2. Reject empty body (`Object.keys(data).length === 0`).
3. Build a dynamic `SET` clause from only the provided fields + `updated_at = now()`.
4. Execute `INSERT ... ON CONFLICT DO UPDATE` so the row is created on first `PUT` if it didn't exist.
5. Return `{ message: "Preferences updated", preferences: { ...updatedFields } }`.

---

## 9. Push Tokens Routes (`src/routes/pushTokens.routes.ts`)

The push-tokens routes manage FCM device token registration for push notification delivery.

### 9.1 Overview

**File**: [src/routes/pushTokens.routes.ts](src/routes/pushTokens.routes.ts)
**Base path**: `/api/v1/push-tokens`
**Auth**: All endpoints — router-level `authMiddleware`.

### 9.2 Endpoints

---

#### `POST /api/v1/push-tokens`

**Purpose**: Register (or refresh) a device push token.

**Request body** (Zod-validated):

```typescript
{
  token: string;                           // required, min length 1
  platform?: "ios" | "android" | "web";   // default "web"
}
```

**Behavior**:

1. Validate body with `RegisterTokenSchema.safeParse(req.body)`.
2. Execute `INSERT INTO push_tokens (user_id, token, platform) ON CONFLICT (user_id, token) DO UPDATE SET platform = EXCLUDED.platform, updated_at = now()`.
3. Return `{ message: "Push token registered", id, platform }` with HTTP 201.

**Idempotency**: Re-registering the same `(user_id, token)` pair updates the `platform` and timestamp but never creates duplicates.

---

#### `GET /api/v1/push-tokens`

**Purpose**: List all registered push tokens for the current user.

**Response**:

```json
{
  "tokens": [
    {
      "id": "uuid",
      "token": "fcm-token",
      "platform": "ios",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "count": 1
}
```

Ordered by `updated_at DESC`.

---

#### `DELETE /api/v1/push-tokens/:id`

**Purpose**: Remove a specific push token belonging to the current user.

**Behavior**: `DELETE FROM push_tokens WHERE id = $1 AND user_id = $2`. Throws `NotFoundError("Push token")` if no row was deleted (prevents deleting another user's tokens).

### 9.3 Notes

- Tokens are referenced by the push notification service during delivery.
- If `FIREBASE_PROJECT_ID` is not configured, the push service skips sending but tokens can still be stored.
- Currently, only the first device token is used during delivery (no multi-device fan-out).

## 10. Workflow Action Routes (`src/routes/workflow.actions.routes.ts`)

The workflow action route allows a user to resume a paused workflow execution from a notification action button (e.g., "Accept", "Decline", "Reschedule").

### 10.1 Overview

**File**: [src/routes/workflow.actions.routes.ts](src/routes/workflow.actions.routes.ts)
**Base path**: `/api/v1/workflows`
**Auth**: `authMiddleware` + `workflowActionRateLimit`.

### 10.2 Endpoint

---

#### `POST /api/v1/workflows/actions`

**Purpose**: Submit a user action to resume a `waiting` workflow execution.

**Request body** (Zod-validated):

```typescript
{
  executionId: string;   // UUID of the paused execution
  stepId: string;        // Step ID waiting for input
  actionKey: string;     // Action chosen (e.g., "reschedule", "decline")
  payload?: object;      // Optional additional data
  token?: string;        // Optional HMAC signed action token
}
```

**Behavior**:

1. Validate body with Zod; throw `BadRequestError` on failure.
2. If `token` is present: call `verifyActionToken(token)`. On success, the token's embedded `{ executionId, stepId, actionKey }` override the body fields — this prevents tampering. Throws `TokenError` → `UnauthorizedError` on failure.
3. Load the execution via `getExecution(executionId)`. Throw `NotFoundError` if not found or `execution.user_id !== user.id` (ownership guard).
4. Verify `execution.status === "waiting"`. Throw `BadRequestError("Execution is not waiting for input")` otherwise.
5. Compute deterministic job ID: `workflow|resume|${executionId}|${stepId}|${actionKey}`.
6. Enqueue a `workflow.resume` job on the `workflows` queue with that job ID (BullMQ deduplication), `attempts: 5`, exponential backoff.
7. Call `audit({ action: "workflow.action.submitted", executionId, stepId, actionKey })`.
8. Return `202 { message: "Action submitted", executionId, stepId, actionKey }`.

**Response** (HTTP 202):

```json
{
  "message": "Action submitted",
  "executionId": "uuid",
  "stepId": "step-id",
  "actionKey": "reschedule"
}
```

### 10.3 Safety and Idempotency

| Mechanism             | Behavior                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Deterministic job ID  | BullMQ ignores a second enqueue with the same job ID — prevents double-resume.                |
| Engine step guard     | The resume processor verifies `step.status !== "completed"` before acting.                    |
| Signed token override | Token payload binds the execution/step/action at signing time; body tampering is neutralized. |
| Rate limit            | `workflowActionRateLimit` prevents rapid-fire submissions.                                    |

---

## 11. Workflow Execution Routes (`src/routes/workflows.routes.ts`)

The workflows routes expose read-only visibility into a user's workflow executions and their constituent steps.

### 11.1 Overview

**File**: [src/routes/workflows.routes.ts](src/routes/workflows.routes.ts)
**Base path**: `/api/v1/workflows`
**Auth**: All endpoints — router-level `authMiddleware`.

### 11.2 Endpoints

---

#### `GET /api/v1/workflows/executions`

**Purpose**: Paginated list of the current user's workflow executions.

**Request query params**:

| Param    | Required | Default | Constraints                                                    |
| -------- | -------- | ------- | -------------------------------------------------------------- |
| `status` | No       | —       | One of `pending`, `running`, `waiting`, `completed`, `failed`. |
| `limit`  | No       | `20`    | `1`–`100`.                                                     |
| `offset` | No       | `0`     | Non-negative integer.                                          |

**Behavior**:

1. Validate `status` against the allowed enum; throw `BadRequestError` if invalid.
2. Validate `limit` bounds; throw `BadRequestError` if out of range.
3. Query `workflow_executions JOIN workflows` filtered by `user_id` (and optional `status`), ordered by `updated_at DESC`.
4. For each row, call `buildExecutionSummary(context)` — returns a concise object derived from the execution context (e.g., conflict highlights, event titles) rather than the full context blob.
5. Return `{ executions: [...], total, limit, offset }`.

**Response snippet**:

```json
{
  "executions": [
    {
      "id": "uuid",
      "workflowId": "uuid",
      "workflowName": "Conflict Resolution",
      "status": "waiting",
      "currentStep": "notify-user",
      "summary": { ... },
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "total": 12,
  "limit": 20,
  "offset": 0
}
```

---

#### `GET /api/v1/workflows/executions/:id`

**Purpose**: Full details of a single execution owned by the current user.

**Behavior**:

1. Query `workflow_executions JOIN workflows WHERE id = $1 AND user_id = $2`. Throw `NotFoundError` if missing.
2. Call `sanitizeContext(execution.context)` — strips keys prefixed with `_internal` and any `accessToken` / `refreshToken` fields before returning to the client.
3. Query `workflow_execution_steps WHERE execution_id = $1 ORDER BY started_at ASC NULLS LAST`.
4. Return the execution object (with sanitized context) plus the `steps` array.

**Response snippet**:

```json
{
  "execution": {
    "id": "uuid",
    "workflowId": "uuid",
    "workflowName": "Conflict Resolution",
    "triggerType": "calendar.conflict.detected",
    "status": "waiting",
    "currentStep": "notify-user",
    "context": { "event": {...}, "conflict": {...} },
    "createdAt": "...",
    "updatedAt": "..."
  },
  "steps": [
    {
      "stepId": "detect-conflict",
      "status": "completed",
      "attempt": 1,
      "output": {...},
      "error": null,
      "startedAt": "...",
      "finishedAt": "...",
      "nextRunAt": null
    }
  ]
}
```

### 11.3 Data Hygiene

- **List view** calls `buildExecutionSummary()` — prevents full context blobs in list payloads.
- **Detail view** calls `sanitizeContext()` — strips `_internal.*`, `accessToken`, `refreshToken` before the response leaves the server.

## 12. Security Utilities (`src/security`)

The `security` folder contains all cryptographic primitives, token management, and middleware that protect the application at rest and in transit.

### 12.1 Overview

| File                                              | Purpose                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [keyring.ts](src/security/keyring.ts)             | Load and manage AES-256 encryption keys by ID (KID).                                                            |
| [crypto.ts](src/security/crypto.ts)               | AES-256-GCM encrypt and decrypt helpers.                                                                        |
| [idempotency.ts](src/security/idempotency.ts)     | Redis-backed short-window dedupe, webhook key helpers, durable audit-log idempotency, request guard middleware. |
| [signedActions.ts](src/security/signedActions.ts) | HMAC-SHA256 signed token generation and verification for workflow action links.                                 |
| [supabaseJwt.ts](src/security/supabaseJwt.ts)     | Local JWKS-backed Supabase JWT verification.                                                                    |

---

#### [src/security/keyring.ts](src/security/keyring.ts)

**Purpose**: Load AES-256 encryption keys from environment variables, index them by key ID (KID), and provide a single active key for new encryptions.

**Key exports**:

```typescript
registerKey(opts: { kid: string; hexKey: string; active: boolean }): void
initKeyring(): void
getKey(kid?: string): { kid: string; keyBuffer: Buffer }
```

**Behavior**:

1. `initKeyring()` reads `ENCRYPTION_KEY` (registered as `kid="1"`, active). Optionally reads `ENCRYPTION_KEY_2` … `ENCRYPTION_KEY_10` and registers each as inactive.
2. `registerKey()` validates that `hexKey` is exactly 64 hex characters (= 32 bytes for AES-256). Throws if invalid.
3. `getKey()` with no argument returns the single active key. `getKey(kid)` returns the keyed entry and throws `KeyNotFoundError` if the KID is not registered.

**Key rotation procedure**:

1. Add `ENCRYPTION_KEY_2=<new 64-char hex>` (etc.) to the environment.
2. Deploy — new encryptions use the active key (KID "1" or whichever is `active`).
3. To promote a key: change its `active` flag in the config and update `initKeyring()` logic (or swap env vars and redeploy).
4. Backfill old records by re-encrypting with the new key.
5. Remove the old key from env after backfill completes.

---

#### [src/security/crypto.ts](src/security/crypto.ts)

**Purpose**: AES-256-GCM authenticated encryption/decryption for OAuth tokens stored in the database.

**Key exports**:

```typescript
encrypt(plaintext: string): EncryptedPayload
decrypt(ciphertext: string, iv: string, tag: string, kid: string): string

interface EncryptedPayload {
  ciphertext: string;  // hex-encoded
  iv:         string;  // hex-encoded, 12 bytes
  tag:        string;  // hex-encoded, 16 bytes
  kid:        string;  // key ID used
}
```

**Behavior — `encrypt(plaintext)`**:

1. Call `getKey()` to get the current active key.
2. Generate a cryptographically random 12-byte IV via `crypto.randomBytes(12)`.
3. Create an `aes-256-gcm` cipher.
4. Encrypt the UTF-8 plaintext; obtain the 16-byte GCM auth tag.
5. Return `{ iv, tag, ciphertext, kid }` — all hex-encoded.

**Behavior — `decrypt(ciphertext, iv, tag, kid)`**:

1. Call `getKey(kid)` to retrieve the key that was active at encryption time.
2. Create an `aes-256-gcm` decipher; set the auth tag.
3. Decrypt and return the plaintext. Throws on authentication failure (tampered data or wrong key).

**Example**:

```typescript
const { iv, tag, ciphertext, kid } = encrypt("my-access-token");
const plaintext = decrypt(ciphertext, iv, tag, kid); // "my-access-token"
```

---

#### [src/security/idempotency.ts](src/security/idempotency.ts)

**Purpose**: Provide Redis-backed short-window deduplication and durable DB idempotency for webhook processing, effect de-duplication, and audit logging.

**Key exports**:

```typescript
isDuplicate(key: string, ttlSeconds: number): Promise<boolean>
buildWebhookDedupeKey(channelId: string, resourceId: string, messageNumber: string): string
buildEffectKey(...parts: string[]): string
recordAuditLog(entry: AuditLogEntry): Promise<boolean>
requireIdempotencyKey: express.RequestHandler
```

**Behavior**:

| Export                       | Behavior                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isDuplicate(key, ttl)`      | Redis `SET NX EX`. Returns `true` if key already existed (duplicate request); `false` if newly set (first time seen).                                                                                                                                    |
| `buildWebhookDedupeKey(...)` | Returns `webhook:google:<channelId>:<resourceId>:<messageNumber>`.                                                                                                                                                                                       |
| `buildEffectKey(...parts)`   | Returns `effect:<parts.join(":")>`.                                                                                                                                                                                                                      |
| `recordAuditLog(entry)`      | `INSERT INTO audit_log ... ON CONFLICT (action, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`. Returns `true` if row was inserted (new action), `false` if skipped (duplicate). DB failures are logged and return `false`. |
| `requireIdempotencyKey`      | Express middleware. Rejects with `400 Bad Request` if `Idempotency-Key` header is missing.                                                                                                                                                               |

---

#### [src/security/signedActions.ts](src/security/signedActions.ts)

**Purpose**: Issue and verify HMAC-SHA256 signed tokens that authorize a specific workflow action — used in notification deep-links to prevent tampering.

**Key exports**:

```typescript
signActionToken(input: SignActionInput, ttlSeconds?: number): string
verifyActionToken(token: string): SignedActionPayload
class TokenError extends Error {}

interface SignedActionPayload {
  executionId: string;
  stepId: string;
  actionKey: string;
  exp: number;    // Unix seconds
  nonce: string;  // 16-byte hex
}
```

**Token format**: `<base64url(JSON payload)>.<hmac-sha256-hex>`

**Behavior — `signActionToken(input, ttlSeconds = 86400)`**:

1. Generate a 16-byte random nonce (hex-encoded).
2. Compute `exp = Math.floor(Date.now() / 1000) + ttlSeconds`.
3. Assemble payload `{ executionId, stepId, actionKey, exp, nonce }`.
4. Sign with `HMAC-SHA256` using `ACTION_SIGNING_SECRET` (required 32-byte hex env var).
5. Return `<base64url(JSON)>.<hmac-hex>`.

**Behavior — `verifyActionToken(token)`**:

1. Split on `.`; reject malformed tokens with `TokenError`.
2. Recompute HMAC and compare with **`timingSafeEqual`** — prevents timing attacks.
3. Throw `TokenError("Invalid signature")` on mismatch.
4. Decode and parse the payload JSON. Throw on parse failure.
5. Check `payload.exp > Date.now() / 1000`. Throw `TokenError("Token expired")` if stale.
6. Call `isDuplicate("nonce:" + nonce, remainingTtl + 300)` — marks nonce as spent in Redis with a 5-minute grace. Throw `TokenError("Token already used")` on replay.
7. Return the verified payload.

---

#### [src/security/supabaseJwt.ts](src/security/supabaseJwt.ts)

**Purpose**: Verify Supabase-issued JWTs locally using the JWKS endpoint — no round-trip to Supabase per request.

**Key exports**:

```typescript
verifyJwt(token: string): Promise<{ userId: string; email: string }>
invalidateJwksCache(): void
```

**Behavior — `verifyJwt(token)`**:

1. `getJwks()` returns a singleton `RemoteJWKSet` created from `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`.
   - JWKS cache max-age: 1 hour (`cacheMaxAge: 3_600_000`).
   - Cooldown between fetches: 30 seconds (`cooldownDuration: 30_000`); automatic refresh on `kid` mismatch.
2. Call `jwtVerify(token, jwks, { algorithms: ["RS256", "ES256"], issuer: "${SUPABASE_URL}/auth/v1", audience: "authenticated" })`.
3. Extract `sub` → `userId` and `email` from claims. Throw `UnauthorizedError` if either is missing.

**`invalidateJwksCache()`**: Sets the singleton to `null`, forcing the next `verifyJwt()` call to re-fetch the JWKS. Used in tests and during emergency key rotation.

### 12.2 Operational Notes

- `initKeyring()` **must** be called at startup (in both `server.ts` and `worker.ts`) before any encrypt/decrypt operation.
- `ACTION_SIGNING_SECRET` must be set to a 32-byte hex string for signed action tokens. Missing → startup throws.
- Redis must be available for webhook deduplication, nonce replay protection, and idempotent audit-log writes.
- When rotating encryption keys: add new key to env, deploy, backfill old records, then remove the old key env var after full backfill.

---

## 13. Services Folder (`src/services`)

The `services` folder contains all business logic. Each file is responsible for a single domain: auth token storage, conflict analysis, event syncing, AI draft generation, notifications, and so on. Thin route handlers call services; services contain the complexity.

### 13.1 Core Services

---

#### [src/services/audit.service.ts](src/services/audit.service.ts)

**Purpose**: Write durable, deduplicated audit records and emit structured log lines for every side-effecting action.

**Key exports**:

```typescript
async function audit(params: AuditParams): Promise<boolean>;
function createAuditContext(baseParams: Partial<AuditParams>): BoundAuditFn;
```

**Behavior — `audit(params)`**:

1. Call `recordAuditLog(params)` (from `idempotency.ts`) — inserts into `audit_log` with `ON CONFLICT DO NOTHING` on `(action, idempotency_key)`.
2. Emit a structured log line (`logger.info`) regardless of whether the row was new.
3. Return `true` if the row was newly inserted; `false` if it was a duplicate.
4. Database failures are caught — a warning is logged and `false` is returned (non-fatal: audit failures do not abort the calling operation).

**`createAuditContext(baseParams)`**: Returns a partially-applied `audit` function with `requestId`, `userId`, and `log` pre-bound. Workers and request handlers create a context once and call it throughout the request lifecycle.

---

#### [src/services/auth.service.ts](src/services/auth.service.ts)

**Purpose**: Persist and retrieve encrypted OAuth tokens, detect forced re-authentication, and silently refresh Google access tokens.

**Key exports**:

```typescript
async function storeTokens(
  userId,
  provider,
  tokens: OAuthTokens,
): Promise<void>;
async function getTokens(userId, provider): Promise<ConnectedAccount | null>;
async function markReauthRequired(userId, provider): Promise<void>;
async function refreshGoogleTokenIfNeeded(userId): Promise<string>;
class ReauthRequiredError extends Error {}
```

**Behavior — `storeTokens()`**:

- Encrypts `accessToken` with `encrypt()` (independent random IV).
- Encodes `refreshToken` as `iv:tag:kid:ciphertext` and stores in `refresh_token_enc` column.
- Upserts into `connected_accounts` — sets `reauth_required = false`, `expires_at`, and all encrypted columns.

**Behavior — `getTokens()`**:

- Reads the `connected_accounts` row. Returns `null` if no row exists.
- If `reauth_required = true`, throws `ReauthRequiredError`.
- Decrypts access token from columns; decrypts refresh token from the `iv:tag:kid:ciphertext` prefix format.
- Returns `ConnectedAccount { accessToken, refreshToken, expiresAt, provider }`.

**Behavior — `refreshGoogleTokenIfNeeded()`**:

1. Call `getTokens(userId, "google")`.
2. If `expiresAt` is > 5 minutes from now, return the current `accessToken` immediately.
3. Use `oauth2Client.setCredentials({ refresh_token })` and call `oauth2Client.refreshAccessToken()`.
4. On 401 / 403 response from Google: call `markReauthRequired(userId, "google")` and throw `ReauthRequiredError`.
5. On success: call `storeTokens(...)` with the new tokens and return the fresh `accessToken`.

---

#### [src/services/conflicts.service.ts](src/services/conflicts.service.ts)

**Purpose**: Detect, score, persist, and enqueue conflict detection jobs for calendar events.

**Key exports**:

```typescript
async function detectConflicts(userId, from?, to?): Promise<ConflictResult[]>;
async function persistConflicts(
  userId,
  pairs,
): Promise<EnrichedConflictResult[]>;
async function enqueueConflictDetection(userId): Promise<void>;
```

**Conflict scoring algorithm**:

The scorer assigns a numeric score to each overlapping event pair and maps the score to a severity:

| Score | Severity |
| ----- | -------- |
| ≥ 5   | `high`   |
| ≥ 2   | `medium` |
| < 2   | `low`    |

Score contributions:

- Overlap duration < 15 min → **+1**; 15–60 min → **+2**; > 60 min → **+3**
- Buffer violation (within user's `defaultBufferMinutes`) → **+1**
- Both events have the authenticated user as organizer → **+2**
- Both events have required attendees → **+2**; only one → **+1**

**Behavior — `detectConflicts(userId, from?, to?)`**:

1. Load user preferences to get `defaultBufferMinutes`.
2. Execute a SQL self-join on `events` to find candidate overlapping pairs where both events belong to `userId` and `start_time` ranges overlap with buffer applied.
3. Score each pair and return `ConflictResult[]`.

**Behavior — `persistConflicts(userId, pairs)`**:

1. Upsert each pair into `conflicts` table using a canonical event-pair ordering (`MIN(id), MAX(id)`) to ensure `(event_a_id, event_b_id)` is always deterministic.
2. Mark previously active conflicts not in the current result set as resolved (`is_active = false`).
3. Return enriched results with `isNew` and `severityChanged` flags.

**`enqueueConflictDetection(userId)`**: Fire-and-forget enqueue to the `conflicts` queue. Uses a time-bucketed job ID (`conflicts|<userId>|<minuteBucket>`) to coalesce rapid consecutive triggers.

---

#### [src/services/events.service.ts](src/services/events.service.ts)

**Purpose**: Upsert, list, and delete events locally; orchestrate provider-backed mutations (reschedule, decline, delete).

**Key exports**:

```typescript
async function upsertEvent(event: NormalizedEvent): Promise<UpsertResult>;
async function getUserEvents(userId, from?, to?): Promise<NormalizedEvent[]>;
async function getEventById(userId, id): Promise<NormalizedEvent | null>;
async function deleteEvent(userId, id): Promise<void>;
async function rescheduleEventAtProvider(
  user,
  eventId,
  opts,
): Promise<NormalizedEvent>;
async function declineEventAtProvider(
  user,
  eventId,
  calendarId?,
): Promise<void>;
async function deleteEventAtProvider(user, eventId): Promise<void>;
async function deleteEventByExternalId(
  userId,
  externalId,
  provider,
): Promise<void>;
```

**Behavior — `upsertEvent(event)`**:

1. Execute `INSERT INTO events (...) ON CONFLICT (external_id, user_id) DO UPDATE SET ...`.
2. Detect whether this was an insert or update: `xmax !== "0"` → update.
3. Create an event snapshot (insert into `event_snapshots`).
4. Fire-and-forget: emit `calendar.event.upserted` trigger (via `emitter.emit()`).
5. Fire-and-forget: call `enqueueConflictDetection(userId)`.
6. Return `{ event, wasUpdated }`.

---

#### [src/services/eventTypeRules.service.ts](src/services/eventTypeRules.service.ts)

**Purpose**: Load per-user event classification rules from the database and classify a normalized event to an `event_type` string.

**Key exports**:

```typescript
async function loadActiveRules(
  userId: string,
  provider: string,
): Promise<RuleRow[]>;
function classifyEvent(event: NormalizedEvent, rules: RuleRow[]): string;

interface RuleDefinition {
  conditions: RuleCondition[];
  match: "any" | "all";
}
interface RuleCondition {
  field: string; // dot-path into event object e.g. "title"
  op:
    | "contains"
    | "equals"
    | "starts_with"
    | "ends_with"
    | "matches_regex"
    | "not_contains"
    | "not_equals"
    | "not_starts_with"
    | "not_ends_with"
    | "not_matches_regex";
  value: string;
  caseSensitive?: boolean; // default false
}
```

**Behavior — `loadActiveRules()`**: Fetches rules where `(user_id = $1 OR user_id IS NULL) AND provider = $2 AND is_active = true` ordered by `priority ASC` (lower number = higher priority).

**Behavior — `classifyEvent(event, rules)`**:

- Iterates rules in priority order; returns the first matching rule's `event_type`.
- A rule matches if all conditions (when `match = "all"`) — or any condition (`match = "any"`) — evaluate to `true`.
- Invalid regex patterns are caught and treated as non-match (no throw).
- Returns `"general"` if no rule matches.

---

#### [src/services/oauth-state.service.ts](src/services/oauth-state.service.ts)

**Purpose**: Create and consume single-use OAuth state tokens to prevent CSRF in the OAuth flow.

**Key exports**:

```typescript
async function createOAuthState(
  userId: string,
  provider: string,
): Promise<string>;
async function consumeOAuthState(
  token: string,
): Promise<{ userId: string; provider: string } | null>;
```

**Behavior**:

- `createOAuthState()`: Generates 16 random bytes (128-bit), hex-encodes them as `token`. Stores `JSON.stringify({ userId, provider })` at Redis key `oauth_state:<token>` with `EX 600` (10-minute TTL). Returns `token`.
- `consumeOAuthState()`: Atomically GET then DEL the Redis key in a pipeline. Returns the parsed `{ userId, provider }` object, or `null` if the key was missing (expired or already consumed).

---

#### [src/services/workflows.service.ts](src/services/workflows.service.ts)

**Purpose**: Read-only loaders for workflow engine database rows. All writes go through `src/workflow/state.ts`.

**Key exports**:

```typescript
async function getExecution(id: string): Promise<ExecutionRow | null>;
async function getWorkflow(id: string): Promise<WorkflowRow | null>;
async function getStep(
  executionId: string,
  stepId: string,
): Promise<StepRow | null>;
```

**Behavior**:

- `getWorkflow()` parses the `definition` JSON column through `WorkflowDefinitionSchema.parse()` — throws a typed Zod error if the stored definition is structurally invalid.
- All three functions return `null` on missing rows (no throw).
- These are used by the workflow engine and action routes; never called with cross-user IDs.

---

### 13.2 AI Services (`src/services/ai`)

---

#### [src/services/ai/ai.service.ts](src/services/ai/ai.service.ts)

**Purpose**: Orchestrate end-to-end AI email draft generation from trigger input to persisted `ai_outputs` row.

**Key exports**:

```typescript
function computeAiIdempotencyKey(executionId, stepId, inputData): string;
async function generateEmailDraft(
  params: GenerateEmailDraftParams,
): Promise<EmailDraft>;
```

**Behavior — `generateEmailDraft()`**:

1. Compute key: `ai:email_draft:<executionId>:<stepId>:<sha256(JSON.stringify(inputData)).slice(0,16)>`.
2. Check for an existing `ai_outputs` row with that key — return cached result if found.
3. Apply per-user hourly rate limit (Redis counter, configurable cap). Throw `RateLimitError` if exceeded.
4. Build a prompt via `buildEmailConflictPrompt(params)` and call the AI provider.
5. Validate the response with `EmailDraftSchema.parse()`. On validation failure, call `buildFallbackEmailDraft(params)` — guarantees a usable draft is always returned.
6. Persist the `ai_outputs` row (idempotent — `ON CONFLICT DO UPDATE`).
7. Return the `EmailDraft` object.

---

#### [src/services/ai/provider.ts](src/services/ai/provider.ts)

**Purpose**: Provider abstraction and factory for AI backend selection.

**Key exports**: `getProvider()`, `setProvider()` (test injection), `AIProvider` interface.

Supports `openai` (JSON-mode, `temperature=0`, timeout) and `demo` (deterministic template for development).

---

#### [src/services/ai/schemas.ts](src/services/ai/schemas.ts)

**Purpose**: Define and enforce the AI output contract.

**Key exports**: `EmailDraftSchema` (Zod), `buildFallbackEmailDraft()`.

`EmailDraftSchema` requires `subject`, `body`, `recipientEmail`, and `recipientName`. `buildFallbackEmailDraft()` constructs a valid draft from input context without AI, guaranteeing the pipeline never fails silently.

> **Note on recipients**: `EmailDraftSchema.recipientEmail` is the AI output contract — a single optional address used in the prompt. The workflow step (`email_generate_preview`) separately builds a `recipientEmails: string[]` list from the event attendees table, which is what actually drives delivery in `email_send`.

---

### 13.3 Calendar Services (`src/services/calendar`)

---

#### [src/services/calendar/google.ts](src/services/calendar/google.ts)

**Purpose**: Google Calendar API adapter. Wraps all Google API calls and maps errors to application-level types.

**Key exports**:

```typescript
async function fetchGoogleEvents(
  userId,
  calendarId?,
  pageToken?,
): Promise<GoogleEventPage>;
async function fetchGoogleEventsIncremental(
  userId,
  syncToken,
  calendarId?,
): Promise<GoogleEventPage>;
async function patchGoogleEvent(
  userId,
  eventId,
  patch,
  calendarId?,
): Promise<void>;
async function deleteGoogleEvent(userId, eventId, calendarId?): Promise<void>;
async function declineGoogleEvent(userId, eventId, calendarId?): Promise<void>;
class GoogleSyncTokenExpiredError extends Error {}
```

`fetchGoogleEventsIncremental` throws `GoogleSyncTokenExpiredError` on HTTP 410 — the caller (`sync.ts`) catches this to trigger a full resync.

---

#### [src/services/calendar/sync.ts](src/services/calendar/sync.ts)

**Purpose**: Full and incremental calendar sync coordinator.

**Key exports**:

```typescript
async function fullSync(userId, calendarId?): Promise<SyncCounts>;
async function incrementalSync(userId, calendarId?): Promise<SyncCounts>;
async function syncUserCalendar(userId, provider?, since?): Promise<SyncCounts>;
class FullResyncRequiredError extends Error {}
```

**Behavior**:

- `incrementalSync()` reads the stored sync token via `getSyncToken()`. On `GoogleSyncTokenExpiredError` (410), clears the token and re-throws `FullResyncRequiredError`.
- `fullSync()` / `incrementalSync()` both advance the sync cursor **only after** successful ingestion of all pages.
- Events marked `cancelled` by Google are deleted locally via `deleteEventByExternalId()`.

---

#### [src/services/calendar/googleWatch.service.ts](src/services/calendar/googleWatch.service.ts)

**Purpose**: Manage Google Calendar push notification channels.

**Key exports**: `createWatchChannel()`, `getChannelByChannelId()`, `getExpiringChannels()`, `stopWatchChannel()`, `renewWatchChannel()`.

**Channel TTL**: ~6 days (under Google's 7-day maximum) to allow renewal before expiration.

`stopWatchChannel()` calls Google's stop API and then deletes the DB row — it tolerates Google-side failures (channel already expired) and always cleans up the local state.

---

#### [src/services/calendar/googleSyncCursor.service.ts](src/services/calendar/googleSyncCursor.service.ts)

**Purpose**: Store and retrieve per-channel incremental sync tokens.

**Key exports**: `getSyncToken(userId, calendarId)`, `setSyncToken(userId, calendarId, token)`, `clearSyncToken(userId, calendarId)`.

---

#### [src/services/calendar/normalizer.ts](src/services/calendar/normalizer.ts)

**Purpose**: Convert raw Google Calendar event objects into the internal `NormalizedEvent` shape.

**Key exports**: `normalizeGoogleEvent(raw, userId, provider)`.

**Behavior**: Skips cancelled or structurally invalid events (returns `null`). Captures recurrence metadata (`recurrenceRule`, `recurringEventId`). Calls `classifyEvent()` to assign `eventType` based on active rules.

---

### 13.4 Email Services (`src/services/email`)

---

#### [src/services/email/email.service.ts](src/services/email/email.service.ts)

**Purpose**: Provider-agnostic entrypoint for email draft creation and sending.

**Key exports**:

```typescript
async function createEmailDraft(userId, draft): Promise<EmailDraftRecord>;
async function sendEmail(userId, draftId): Promise<void>;
class ProviderNotConnectedError extends Error {}
```

**Behavior**: Detects the user's connected provider. Routes to `createGmailDraft()` / `sendGmailDraft()` for Google accounts. Microsoft Graph (Outlook) is recognized but not yet implemented — throws `NotImplementedError`.

---

#### [src/services/email/gmail.service.ts](src/services/email/gmail.service.ts)

**Purpose**: Gmail-specific draft creation and sending with idempotency and auth-error handling.

**Key exports**:

```typescript
async function createGmailDraft(userId, draft): Promise<GmailDraftRecord>;
async function sendGmailDraft(userId, draftId): Promise<void>;
function computeDraftIdempotencyKey(userId, executionId, stepId): string;
class AuthError extends Error {}
```

**Behavior — `createGmailDraft()`**:

1. Compute idempotency key.
2. Check `email_drafts` table for an existing row by key — return early if found (prevents duplicate drafts).
3. Encode MIME message: RFC 2047 base64 for subject; base64url body (Gmail API requirement).
4. Call `gmail.users.drafts.create()`.
5. On HTTP 401/403: call `markReauthRequired()` and throw `AuthError` (non-retryable, maps to `UnrecoverableError`).
6. On success: insert row into `email_drafts` and return the record.

**Behavior — `sendGmailDraft()`**: Calls `gmail.users.drafts.send()` and updates the `email_drafts` row with `sent_at`, `message_id`, and `thread_id`.

---

### 13.5 Notification Services (`src/services/notifications`)

---

#### [src/services/notifications/notification.service.ts](src/services/notifications/notification.service.ts)

**Purpose**: Orchestrate notification delivery — enqueue, deliver, fall back, and audit.

**Key exports**: `enqueueNotification(params)`, `deliverNotification(params)`.

**Behavior — `deliverNotification()`**:

1. Attempt push notification via `sendPushNotification()`.
2. If push is not configured, has no token, or returns an FCM error: fall back to `sendEmailFallback()`.
3. Write a `notification_deliveries` row recording the channel used and the outcome.

---

#### [src/services/notifications/push.service.ts](src/services/notifications/push.service.ts)

**Purpose**: Send FCM push notifications via the HTTP v1 API with a service-account JWT.

**Key exports**: `sendPushNotification(userId, payload)`.

Result reasons: `sent` · `not_configured` (Firebase env vars missing) · `no_token` (user has no registered push token) · `fcm_error` (FCM rejected the message).

Currently targets the **first** registered device token only — no multi-device fan-out.

---

#### [src/services/notifications/emailFallback.service.ts](src/services/notifications/emailFallback.service.ts)

**Purpose**: Send a notification as an email draft (with action deep-links embedded) when push is unavailable.

**Key exports**: `sendEmailFallback(userId, notification)`.

Creates a Gmail draft (idempotent on `computeDraftIdempotencyKey`). Does not auto-send — the draft appears in the user's Gmail Drafts folder.

### 13.6 Current Gaps

| Gap                      | Details                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| Microsoft Graph calendar | Sync path has a placeholder; not implemented.                                   |
| Outlook email            | `email.service.ts` detects Microsoft accounts but throws `NotImplementedError`. |
| Multi-device push        | `push.service.ts` sends only to the first registered push token.                |

---

## 14. Triggers Folder (`src/triggers`)

The triggers folder defines the event pipeline that converts calendar and conflict changes into workflow evaluations. It provides the typing and emission logic that sits between raw domain events (event upserts, deletions, conflict detection) and the workflow engine.

### 14.1 Overview

When something significant happens (event changed, conflict detected), the system emits a **trigger** into the `triggers` queue. The triggers worker then:

1. Finds all active workflows matching that trigger type.
2. Evaluates each workflow's conditions against the trigger payload.
3. For matching workflows, enqueues a `workflow.execute` job.

The triggers folder provides:

- **Type-safe trigger payload schemas** (Zod schemas for all trigger types).
- **Deduplication logic** (60-second bucketing to prevent duplicate processing).
- **Centralized emitter** (safe to call from any service).

### 14.2 File-by-File Breakdown

#### [src/triggers/types.ts](src/triggers/types.ts)

**Purpose**: Define all trigger payload schemas and workflow definition structures.

**Trigger types** (constants):

- `calendar.event.upserted` — event inserted or updated in DB.
- `calendar.event.deleted` — event hard-deleted from DB.
- `calendar.conflict.detected` — conflict found by conflict engine.

**Zod schemas**:

- `CalendarEventUpsertedSchema` — includes event details (ID, provider, type, title, times, organizer) + `wasUpdated` flag.
- `CalendarEventDeletedSchema` — minimal event metadata (external ID + provider).
- `CalendarConflictDetectedSchema` — conflict details (conflicting event IDs, type, severity, overlap minutes) + change flags (`isNew`, `severityChanged`).
- `TriggerPayloadSchema` — discriminated union of all three trigger types (by `triggerType` field).

**Workflow definition schemas**:

- `WorkflowConditionSchema` — single condition with field path (e.g., `"event.eventType"`), operator (`equals`, `contains`, `exists`, etc.), and optional value + case sensitivity.
- `WorkflowTriggerConfigSchema` — array of conditions (AND logic).
- `WorkflowDefinitionSchema` — top-level workflow definition (trigger config + array of steps).

**Exports**: All schemas + TypeScript types (`TriggerPayload`, `CalendarEventUpserted`, etc.).

---

#### [src/triggers/emitter.ts](src/triggers/emitter.ts)

**Purpose**: Convert domain events into BullMQ jobs in the `triggers` queue with built-in deduplication.

**Key function**: `emitTrigger(trigger: TriggerPayload): Promise<void>`

- Extracts stable entity ID from trigger payload:
  - For event triggers: uses `externalEventId`.
  - For conflict triggers: uses sorted join of conflicting event IDs (e.g., `"eventA+eventB"`).
- Computes 60-second bucket: `Math.floor(Date.now() / 60_000)`.
- Generates deterministic job ID: `trigger|emit|<triggerType>|<userId>|<entityId>|<bucket>`.
- Enqueues `trigger.emit` job with that job ID (BullMQ silently ignores duplicate job IDs if already queued/running).
- Uses that job ID as idempotency key as well.

**Deduplication strategy**:

- Multiple rapid triggers for the same entity within the same 60-second window → single job.
- Example: Google webhook fires 3 times for one event update → all coalesce to one job → workflow evaluates once.

**Retry config**:

- Attempts: 5
- Backoff: exponential starting at 2 seconds
- Rationale: emit jobs are lightweight fan-out, so generous retries are fine.

**Safe to call anywhere**: this function never throws on duplicate (BullMQ handles it transparently).

---

### 14.3 How Triggers Flow Through the System

1. **Domain event occurs** (e.g., Google webhook arrives, conflict detected).
2. **Service calls `emitTrigger()`** with typed payload (e.g., from sync service or conflict engine).
3. **BullMQ dedupes** based on job ID (if job already queued/running within same 60-second bucket, second call is no-op).
4. **Triggers worker picks up `trigger.emit` job** (see `/workers/processors/triggers.processor.ts`).
5. **Worker queries `workflows` table** for active workflows matching that trigger type.
6. **Worker evaluates conditions** for each workflow against flattened trigger payload.
7. **For matching workflows**, worker enqueues `workflow.execute` job.
8. **Workflow worker** executes the workflow steps (AI output, send email, etc.).

---

### 14.4 Current Trigger Types in Production

| Trigger Type                 | Emitted By                | Use Case Example                                     |
| ---------------------------- | ------------------------- | ---------------------------------------------------- |
| `calendar.event.upserted`    | Calendar sync service     | "Send me a prep email 1 hour before client meetings" |
| `calendar.event.deleted`     | Calendar sync service     | "Notify me when an important event is cancelled"     |
| `calendar.conflict.detected` | Conflict detection engine | "Alert me when high-severity conflicts are found"    |

---

### 14.5 Extension Points

- **Add new trigger type**: define new schema in `types.ts`, update discriminated union, emit from relevant service.
- **Custom condition operators**: extend `op` enum in `WorkflowConditionSchema` (evaluation logic lives in triggers worker).
- **Change dedup window**: currently hardcoded to 60 seconds (`observedAtBucket()`); adjust divisor in `emitter.ts` if needed.

---

### 14.6 Testing Notes

- To test trigger emission manually:

  ```typescript
  import { emitTrigger } from "./triggers/emitter";
  import { TriggerType } from "./triggers/types";

  await emitTrigger({
    triggerType: TriggerType.CALENDAR_EVENT_UPSERTED,
    userId: "user-uuid",
    event: {
      id: "123",
      externalEventId: "ext-123",
      provider: "google",
      eventType: "meeting",
      title: "Test",
      description: null,
      startTime: "...",
      endTime: "...",
      organizerEmail: null,
      isRecurring: false,
    },
    wasUpdated: false,
    observedAt: new Date().toISOString(),
  });
  ```

- To verify deduplication: call `emitTrigger()` twice within 60 seconds with identical entity ID → only one job appears in BullMQ dashboard.
- To inspect workflow evaluation: check triggers worker logs for condition matching output.

---

## 15. Types Folder (`src/types`)

The types folder provides **shared TypeScript interfaces** used across the entire backend codebase. These types represent core domain entities (users, events, conflicts) and are imported by services, routes, workers, and middleware.

### 15.1 Overview

This is a single file ([src/types/index.ts](src/types/index.ts)) that establishes the canonical type definitions for:

- User identity and authentication
- Connected OAuth accounts
- Normalized calendar events (provider-agnostic)
- Conflict detection results
- Event snapshots

These types are **not Zod schemas** (validation happens separately in routes/services); they are pure TypeScript interfaces for type safety and IDE autocomplete.

### 15.2 Exported Interfaces

#### **AppUser**

Represents the authenticated user identity.

```typescript
interface AppUser {
  id: string; // UUID from `users` table
  email: string; // user's email address
  timezone?: string; // user's timezone (optional)
}
```

**Used in**: auth middleware (`req.user`), all authenticated routes, audit logs.

---

#### **AuthenticatedRequest**

Extends Express `Request` with a typed `user` property.

```typescript
interface AuthenticatedRequest extends Request {
  user: AppUser;
}
```

**Used in**: all route handlers after auth middleware runs. Provides type-safe access to `req.user`.

**Example**:

```typescript
router.get("/me", (req: AuthenticatedRequest, res) => {
  const userId = req.user.id; // ✅ TypeScript knows this exists
  // ...
});
```

---

#### **ConnectedAccount**

Represents an OAuth-connected calendar/email provider.

```typescript
interface ConnectedAccount {
  id: string; // UUID from `connected_accounts` table
  userId: string; // foreign key to `users`
  provider: "google" | "microsoft";
  accessToken: string; // encrypted in DB, decrypted at runtime
  refreshToken: string; // encrypted in DB, decrypted at runtime
  expiresAt: Date; // when access token expires
  createdAt: Date;
  reauthRequired?: boolean; // true if tokens are invalid (user must reconnect)
}
```

**Used in**: OAuth flows, calendar sync, email send, token refresh logic.

**Notes**:

- `accessToken` and `refreshToken` are stored encrypted in the database (see `/security/crypto.ts`).
- `reauthRequired` is set to `true` when refresh fails or the user revokes access on the provider side.

---

#### **NormalizedEvent**

Provider-agnostic representation of a calendar event after normalization.

```typescript
interface NormalizedEvent {
  id?: string; // UUID from `events` table (present after insert)
  userId: string;
  externalEventId: string; // provider's unique event ID
  provider: "google" | "microsoft";
  eventType: string; // e.g., "meeting", "focus", "personal" (from rule matching)
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  organizerEmail: string | null;
  attendees: Attendee[];
  isRecurring: boolean;
  seriesId?: string | null; // provider's recurring series ID
  occurrenceId?: string | null; // provider's occurrence identifier (for single instance)
  metadata: Record<string, unknown>; // provider-specific extra fields
  updatedAt?: Date;
  createdAt?: Date;
}
```

**Used in**: calendar sync, event upsert, conflict detection, workflow triggers.

**Key fields**:

- `eventType`: determined by `event_type_rules` matching logic (see `eventTypeRules.service.ts`).
- `seriesId` / `occurrenceId`: distinguish recurring series from individual occurrences.
- `metadata`: catch-all for provider-specific data (links, call details, etc.).

---

#### **Attendee**

Sub-type for event attendees.

```typescript
interface Attendee {
  email: string;
  displayName?: string;
  responseStatus?: string; // "accepted", "declined", "tentative", etc.
  optional?: boolean;
}
```

**Used in**: `NormalizedEvent.attendees` array.

---

#### **ConflictResult**

Represents a detected calendar conflict (overlapping events or buffer violations).

```typescript
interface ConflictResult {
  id?: string; // UUID from `conflicts` table (present after persist)
  conflictingEvents: [string, string]; // tuple of two event IDs
  conflictType: "overlap" | "buffer_violation";
  severity: "high" | "medium" | "low";
  overlapMinutes: number;
  status?: "active" | "cleared"; // lifecycle status
  firstDetectedAt?: Date;
  lastDetectedAt?: Date;
}
```

**Used in**: conflict detection engine, conflict service, conflict routes, conflict trigger payloads.

**Notes**:

- `conflictingEvents` is always a 2-tuple (conflicts are pairwise).
- `severity` is computed based on event types and overlap duration.
- `status: "cleared"` when the user takes an action (reschedule or decline) on one of the conflicting events — cleared immediately by `clearConflictsByEventId()` in the step handler, before the worker's next pass.

---

#### **EventSnapshot**

Historical snapshot of an event's state (used for change tracking and audit).

```typescript
interface EventSnapshot {
  id: string; // UUID from `event_snapshots` table
  eventId: string; // foreign key to `events`
  snapshot: Record<string, unknown>; // serialized event data at that point in time
  createdAt: Date;
}
```

**Used in**: event update handlers (currently minimal usage; prepared for future change detection workflows).

---

### 15.3 Usage Patterns

#### **In route handlers**:

```typescript
import { AuthenticatedRequest } from "../types";

router.get("/events", async (req: AuthenticatedRequest, res) => {
  const userId = req.user.id; // type-safe
  // ...
});
```

#### **In services**:

```typescript
import { NormalizedEvent, ConnectedAccount } from "../types";

async function syncEvents(
  account: ConnectedAccount,
): Promise<NormalizedEvent[]> {
  // ...
}
```

#### **In workers**:

```typescript
import { ConflictResult } from "../types";

async function handleConflictJob(conflict: ConflictResult) {
  // ...
}
```

---

### 15.4 Why Not Zod Schemas?

These types are **runtime-agnostic TypeScript interfaces**, not validation schemas. This separation provides:

- **Lightweight types** for internal use (no validation overhead).
- **Flexibility**: services can use partial types or extend them without re-validation.
- **Clear boundaries**: validation happens at API boundaries (routes), not in every function.

Where Zod **is** used:

- **Route input validation**: request bodies, query params (see routes files).
- **External payloads**: workflow definitions, trigger payloads, job envelopes (see `/triggers/types.ts` and `/jobs/schemas/envelope.ts`).

---

### 15.5 Extension Guidelines

When adding new domain entities:

1. Define the interface in `src/types/index.ts`.
2. Export it for use across the codebase.
3. Add corresponding database migration if it's a new table.
4. If the type comes from external input (API, webhook), add Zod validation in the route/service.

**Example**: adding a new `CalendarList` type:

```typescript
export interface CalendarList {
  id: string;
  userId: string;
  externalCalendarId: string;
  provider: "google" | "microsoft";
  name: string;
  isDefault: boolean;
  color?: string;
}
```

Then use it in services and routes with appropriate Zod validation at entry points.

---

## 16. Utils Folder (`src/utils`)

The utils folder contains **shared utility functions and classes** used throughout the backend. Currently, it has a single file focused on error handling and HTTP status management.

### 16.1 Overview

This folder provides centralized error types and error-handling middleware that standardize how the application reports failures to clients and logs errors internally.

### 16.2 File: [src/utils/errors.ts](src/utils/errors.ts)

**Purpose**: Define custom error classes and global error-handling middleware for Express.

---

#### **Custom Error Classes**

**`AppError`** (base class)

```typescript
class AppError extends Error {
  statusCode: number;
  isOperational: boolean;
  constructor(message: string, statusCode: number = 500, isOperational = true);
}
```

- **Purpose**: base class for all application-level errors.
- **Fields**:
  - `statusCode`: HTTP status code (default 500).
  - `isOperational`: distinguishes expected errors (true) from programming bugs (false).
- **Usage**: throw when you want to return a specific status code to the client.

**Example**:

```typescript
throw new AppError("Calendar sync failed", 503);
```

---

**`NotFoundError`**

```typescript
class NotFoundError extends AppError {
  constructor(resource: string);
}
```

- **Status code**: 404
- **Usage**: resource not found (event, workflow, account, etc.).

**Example**:

```typescript
const event = await getEvent(eventId);
if (!event) throw new NotFoundError("Event");
```

---

**`UnauthorizedError`**

```typescript
class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized");
}
```

- **Status code**: 401
- **Usage**: missing or invalid authentication token.

**Example**:

```typescript
if (!token) throw new UnauthorizedError("Token missing");
```

---

**`ForbiddenError`**

```typescript
class ForbiddenError extends AppError {
  constructor(message = "Forbidden");
}
```

- **Status code**: 403
- **Usage**: authenticated but not authorized to access the resource.

**Example**:

```typescript
if (event.userId !== req.user.id) {
  throw new ForbiddenError("Access denied to this event");
}
```

---

**`BadRequestError`**

```typescript
class BadRequestError extends AppError {
  constructor(message: string);
}
```

- **Status code**: 400
- **Usage**: invalid input from client (malformed data, validation failure).

**Example**:

```typescript
if (!validateEmail(email)) {
  throw new BadRequestError("Invalid email format");
}
```

---

#### **Global Error Handler Middleware**

**`errorHandler(err, req, res, next)`**

Express error-handling middleware that catches all errors and converts them to HTTP responses.

**Behavior**:

1. **If error is `AppError`**:
   - Log at `error` level if status >= 500, otherwise `warn` level.
   - Respond with `{ error: message, statusCode }`.
2. **If error is unknown** (not `AppError`):
   - Log at `error` level (unexpected error).
   - Respond with generic `{ error: "Internal server error", statusCode: 500 }`.

**Registration** (in [src/app.ts](src/app.ts)):

```typescript
app.use(errorHandler); // Must be last middleware
```

**Example error flow**:

```typescript
// In route:
router.get("/events/:id", async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) throw new NotFoundError("Event");
    res.json(event);
  } catch (err) {
    next(err); // pass to error handler
  }
});

// Error handler catches it:
// → logs "Request error" at warn level
// → responds: { error: "Event not found", statusCode: 404 }
```

**Logging integration**:

- Uses `req.log` (from request ID middleware) if available, otherwise falls back to global `logger`.
- This ensures error logs include the `requestId` for traceability.

---

### 16.3 Usage Guidelines

**When to use each error class**:

| Error Class          | Status | Use Case                                        |
| -------------------- | ------ | ----------------------------------------------- |
| `BadRequestError`    | 400    | Invalid input, validation failure               |
| `UnauthorizedError`  | 401    | Missing/invalid auth token                      |
| `ForbiddenError`     | 403    | Authenticated but lacks permission              |
| `NotFoundError`      | 404    | Resource does not exist                         |
| `AppError` (generic) | custom | Custom status codes (e.g., 503 for unavailable) |

**Async route pattern**:

```typescript
router.post("/foo", async (req: AuthenticatedRequest, res, next) => {
  try {
    // ... business logic with potential throws
    res.json(result);
  } catch (err) {
    next(err); // always pass to next() for error handler to catch
  }
});
```

**Service-level errors**:
Services can throw `AppError` subclasses directly; the route's `catch` block will pass them to the error handler.

```typescript
// In service:
export async function syncCalendar(accountId: string) {
  const account = await getAccount(accountId);
  if (!account) throw new NotFoundError("Connected account");
  // ...
}

// In route:
try {
  await syncCalendar(req.params.accountId);
} catch (err) {
  next(err); // error handler converts NotFoundError → 404 response
}
```

---

### 16.4 Error Response Format

All errors returned to clients follow this JSON structure:

```json
{
  "error": "Human-readable error message",
  "statusCode": 404
}
```

**No stack traces are exposed** to clients (internal logging only).

---

### 16.5 Extension Points

**Adding new error types**:

```typescript
export class ConflictError extends AppError {
  constructor(message = "Resource conflict") {
    super(message, 409);
  }
}
```

**Adding error metadata** (e.g., validation details):

```typescript
export class ValidationError extends AppError {
  public readonly fields: string[];

  constructor(message: string, fields: string[]) {
    super(message, 400);
    this.fields = fields;
  }
}

// In error handler, check for ValidationError and include fields in response
```

**Custom error logging**:
Modify `errorHandler` to send errors to external monitoring (Sentry, Datadog, etc.):

```typescript
if (err.statusCode >= 500) {
  sentry.captureException(err);
}
```

---

### 16.6 Current Usage Across Codebase

- **Auth middleware**: throws `UnauthorizedError` for missing/invalid tokens.
- **Route handlers**: throw `NotFoundError` for missing resources, `ForbiddenError` for permission checks.
- **Services**: throw `AppError` for service-level failures (OAuth errors, API rate limits, etc.).
- **Validation**: Zod validation failures are converted to `BadRequestError` in route input validation.

---

## 17. Workers Folder (`src/workers`)

The workers folder contains **BullMQ worker processes** that consume jobs from Redis queues and execute background tasks. Each worker is responsible for processing specific job types and coordinating with services to perform the actual work.

### 17.1 Overview

Workers run as separate Node.js processes (via [src/worker.ts](src/worker.ts)) and continuously pull jobs from Redis queues. They provide:

- **Job processing**: execute calendar syncs, workflow steps, conflict detection, notifications, and email drafts
- **Retry management**: BullMQ handles automatic retries with exponential backoff
- **Concurrency control**: each worker specifies max concurrent jobs
- **Error handling**: transient errors trigger retries, permanent errors move to DLQ or halt execution
- **Audit logging**: idempotent audit trail for key operations

**Architecture**:

```
Routes/Services → enqueue jobs → Redis Queue → Worker pulls job → Service executes → Worker updates state
```

### 17.2 Worker Registry: [src/workers/index.ts](src/workers/index.ts)

**Purpose**: Start all queue workers and return Worker instances for graceful shutdown.

**Exported function**:

```typescript
function startAllWorkers(): Worker[];
```

**Workers started**:

1. Calendar Sync Worker (`calendar-sync` queue)
2. Triggers Worker (`triggers` queue)
3. Workflow Worker (`workflow` queue)
4. Conflicts Worker (`conflicts` queue)
5. Notifications Worker (`notifications` queue)
6. Email Worker (`email` queue)
7. DLQ Worker (`dlq` queue)

**Usage** (in [src/worker.ts](src/worker.ts)):

```typescript
const workers = startAllWorkers();
// Graceful shutdown: workers.forEach(w => w.close())
```

---

### 17.3 Processor Files

Each processor file exports a `start*Worker()` function that creates a BullMQ Worker instance with job-specific processing logic.

---

#### 17.3.1 Calendar Sync Processor: [src/workers/processors/calendarSync.processor.ts](src/workers/processors/calendarSync.processor.ts)

**Queue**: `calendar-sync`
**Concurrency**: default (1)
**Purpose**: Handle calendar webhook events and periodic syncs from Google/Microsoft.

**Job types handled**:

| Job Type                       | Description                          | Handler Behavior                                                   |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------------------ |
| `google.sync`                  | Incremental or full calendar sync    | Calls `incrementalSync()` or `syncUserCalendar()` based on channel |
| `google.watch.renew`           | Renew expiring watch channel         | Calls `renewWatchChannel()`                                        |
| `microsoft.sync`               | Microsoft Graph delta sync           | TODO (Step 14) — not implemented                                   |
| `microsoft.subscription.renew` | Renew Microsoft webhook subscription | TODO (Step 14) — not implemented                                   |

**Key behaviors**:

- **Incremental sync with channel**: uses sync token for delta queries (efficient)
- **Full sync without channel**: manual `/sync` route trigger, no cursor tracking
- **410 Gone handling**: when sync token is invalid, clears cursor and enqueues fresh full sync job
- **Auth error detection**: 401/403 responses are permanent (no retry)
- **Audit logging**: records sync results (synced/skipped/deleted counts) with idempotency

**Retry policy**: 8 attempts, 30-second exponential backoff (tolerates transient API failures)

**Example flow**:

```
Google webhook → POST /calendar/webhook → enqueue google.sync with channelId
→ worker calls incrementalSync(userId, channelId)
→ fetches delta events since syncToken
→ upserts events → emits triggers → updates syncToken
```

---

#### 17.3.2 Triggers Processor: [src/workers/processors/triggers.processor.ts](src/workers/processors/triggers.processor.ts)

**Queue**: `triggers`
**Concurrency**: 10
**Purpose**: Fan out trigger events to matching workflows and evaluate conditions.

**Job types handled**:

| Job Type           | Description                                          | Handler Behavior                                                         |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `trigger.emit`     | Fan out trigger to all active workflows              | Queries active workflows, enqueues one `trigger.evaluate` per workflow   |
| `trigger.evaluate` | Evaluate conditions for one workflow against trigger | Checks conditions, creates execution if matched, enqueues `workflow.run` |

**Key behaviors**:

**`trigger.emit`**:

1. Parse trigger payload (calendar event upserted/deleted, conflict detected)
2. Query `workflows` table for active workflows matching `trigger_type`
3. For each workflow: enqueue `trigger.evaluate` job with deterministic jobId (60-second bucket dedup)
4. Log fan-out count

**`trigger.evaluate`**:

1. Parse workflow definition and trigger payload
2. Evaluate all conditions (AND logic) using dot-path field matching
3. If conditions pass:
   - Create `workflow_executions` row (status=pending)
   - Create first `workflow_execution_steps` row (status=pending)
   - Enqueue `workflow.run` job for first step
   - Record audit log (`workflow.execution.created`)
4. If conditions fail: skip (no execution created)

**Condition evaluation**:

- Operators: `equals`, `not_equals`, `contains`, `not_contains`, `exists`, `not_exists`
- Field paths: dot-notation (e.g., `event.eventType`, `conflict.severity`)
- Case sensitivity: optional (default case-insensitive)

**Retry policy**: 8 attempts, 5-second exponential backoff

**Example**:

```
Trigger: calendar.event.upserted with event.eventType = "meeting"
Workflow definition: { trigger: { conditions: [{ field: "event.eventType", op: "equals", value: "meeting" }] } }
→ trigger.emit fans out to workflow
→ trigger.evaluate checks conditions → passes
→ creates execution, enqueues workflow.run for first step
```

---

#### 17.3.3 Workflow Processor: [src/workers/processors/workflow.processor.ts](src/workers/processors/workflow.processor.ts)

**Queue**: `workflow`
**Concurrency**: default (1)
**Purpose**: Execute individual workflow steps, manage execution state machine, handle resume/timeout.

**Job types handled**:

| Job Type           | Description                                | Handler Behavior                                           |
| ------------------ | ------------------------------------------ | ---------------------------------------------------------- |
| `workflow.run`     | Run a single step                          | Calls `runStep()`, handles state errors                    |
| `workflow.resume`  | Resume from waiting step after user action | Claims execution, re-runs waiting step with resume payload |
| `workflow.timeout` | Enforce timeout on waiting step            | Advances to timeout branch or fails execution              |

**Key behaviors**:

**`workflow.run`**:

1. Load execution and step state from DB
2. Call `runStep()` from workflow engine ([src/workflow/engine.ts](src/workflow/engine.ts))
3. Engine:
   - Validates execution is in valid state (pending/running)
   - Looks up step handler from step registry
   - Executes handler (AI generation, send email, wait for approval, etc.)
   - Updates step status (completed/failed/waiting)
   - If step completed: automatically enqueues next step's `workflow.run` job
   - If step waiting: execution status → waiting (no next job)
4. Handle errors:
   - `ExecutionStateError`: clean exit (execution already terminal)
   - `UnregisteredStepTypeError`: mark execution failed (no handler available)
   - Other errors: throw for BullMQ retry

**`workflow.resume`**:

1. Guard: execution must be waiting (not completed/failed)
2. Guard: step must be waiting (not completed)
3. Transition execution: waiting → running (claim with DB UPDATE)
4. Re-run waiting step with `resumePayload` (includes `resumeKey` for action identification)
5. Engine continues from there (may complete step and advance, or wait again)

**`workflow.timeout`**:

1. Guard: execution must still be waiting on the specified step
2. If `timeoutNextStepId` is defined: advance to that step
3. Otherwise: mark execution failed

**Retry policy**: 12 attempts, 5-second exponential backoff with 15-minute cap (enforced by backoffStrategy)

**Example**:

```
workflow.run(executionId=uuid, stepId="generate_email", attempt=0)
→ engine loads step definition: { type: "generate_email_with_ai", prompt: "..." }
→ calls AI service → generates email draft
→ step completed → enqueues workflow.run(executionId, stepId="send_email", attempt=0)
```

---

#### 17.3.4 Conflicts Processor: [src/workers/processors/conflicts.processor.ts](src/workers/processors/conflicts.processor.ts)

**Queue**: `conflicts`
**Concurrency**: 5
**Purpose**: Detect calendar conflicts (overlaps, buffer violations), persist to DB, emit triggers.

**Job types handled**:

| Job Type           | Description                       | Handler Behavior                                         |
| ------------------ | --------------------------------- | -------------------------------------------------------- |
| `conflicts.detect` | Run conflict detection for a user | Detects conflicts, persists/clears in DB, emits triggers |

**Key behaviors**:

1. **Stage 1: Detection** — call `detectConflicts(userId, rangeFrom, rangeTo)` (SQL-based ephemeral detection)
2. **Stage 2: Persistence** — call `persistConflicts(userId, detected)`:
   - Upserts active conflict pairs (with severity calculation)
   - Marks as `cleared` only pairs **within the scanned window** that were not re-detected — does **not** touch pairs from other time windows (prevents cross-window stomping)
   - Returns enriched results with stable UUIDs + change flags (`isNew`, `severityChanged`)
3. **Stage 3: Trigger Emission** — emit `calendar.conflict.detected` trigger **only for new or severity-changed conflicts** (suppresses repeat triggers for unchanged conflicts)

**Trigger deduplication**: `emitTrigger()` uses 60-second bucket jobId, so bursts collapse to single evaluation

**Retry policy**: default (BullMQ retry with exponential backoff)

**Example**:

```
User syncs calendar → new event overlaps existing event
→ sync service enqueues conflicts.detect(userId)
→ worker detects overlap → persists to conflicts table with severity=high
→ emits trigger: calendar.conflict.detected with isNew=true
→ triggers worker fans out to workflows (e.g., "alert on high-severity conflicts")
```

---

#### 17.3.5 Notifications Processor: [src/workers/processors/notifications.processor.ts](src/workers/processors/notifications.processor.ts)

**Queue**: `notifications`
**Concurrency**: 10
**Purpose**: Deliver push notifications (FCM) and email fallback.

**Job types handled**:

| Job Type            | Description                  | Handler Behavior                                      |
| ------------------- | ---------------------------- | ----------------------------------------------------- |
| `notification.send` | Send push/email notification | Calls `deliverNotification()` with title/body/actions |

**Key behaviors**:

1. Parse payload: `{ executionId, stepId, title, body, actions }`
2. Call `deliverNotification()` from notification service:
   - Attempts FCM push first (to first registered device token)
   - If push fails/unavailable: falls back to Gmail draft with action links
   - Records delivery in `notification_deliveries` table
3. Actions (buttons) are converted to:
   - **Push**: FCM action buttons with click URLs (`/workflow/actions/resume`)
   - **Email**: signed action links in draft body

**Retry policy**: default
**Current limitation**: only first device token is targeted (no multi-device fan-out yet)

**Example**:

```
Workflow step: wait_for_approval
→ enqueues notification.send(title="Approve Email Draft", body="...", actions=[{key:"approve"}, {key:"reject"}])
→ worker sends push to device
→ user taps "Approve" → frontend calls /workflow/actions/resume → enqueues workflow.resume
```

---

#### 17.3.6 Email Processor: [src/workers/processors/email.processor.ts](src/workers/processors/email.processor.ts)

**Queue**: `email`
**Concurrency**: 3
**Purpose**: Create Gmail drafts (and send, if implemented).

**Job types handled**:

| Job Type             | Description        | Handler Behavior                              |
| -------------------- | ------------------ | --------------------------------------------- |
| `email.draft.create` | Create email draft | Calls `createEmailDraft()`, records audit log |

**Key behaviors**:

1. Validate required fields: `recipients` (string array) or legacy `recipient` (string), `subject`, `body`
2. Normalize: if only `recipient` (string) is present it is wrapped in a `[recipient]` array for backwards compatibility
3. Call `createEmailDraft()` (supports Google only; Microsoft TODO)
4. Service:
   - Computes idempotency key from execution+step (recipients sorted before hashing)
   - Checks `email_drafts` table for existing draft
   - If not exists: calls Gmail API to create draft (MIME `To:` lists all recipients), persists row
   - Returns `{ emailDraftId, providerDraftId, provider, isNew }`
5. Record audit log: `email.draft.created`

**Error handling**:

- `ProviderNotConnectedError`, `AuthError` → `UnrecoverableError` (no retry)
- Other errors → retryable

**Retry policy**: default
**Current limitation**: email queue is not wired from any workflow step (Step 14 TODO)

---

#### 17.3.7 DLQ Processor: [src/workers/processors/dlq.processor.ts](src/workers/processors/dlq.processor.ts)

**Queue**: `dlq`
**Concurrency**: 1
**Purpose**: Log permanently-failed jobs for manual inspection and replay.

**Job types handled**: All (receives jobs moved from any queue after exhausting retries)

**Key behaviors**:

1. Log full job context: `{ data, attemptsMade, failedReason }`
2. Write durable audit log entry: `job.dead_letter` with original job data
3. No automatic replay mechanism (manual intervention required)

**What moves jobs to DLQ**:

- Workflow worker when workflow step handler throws `UnrecoverableError`
- BullMQ when job exceeds max attempts and DLQ is configured

**Current limitation**: only workflow worker explicitly moves jobs to DLQ; other workers retry until max attempts then fail

---

### 17.4 Worker Lifecycle and Error Handling

**Startup** (in [src/worker.ts](src/worker.ts)):

```typescript
const workers = startAllWorkers();
// Workers start polling Redis immediately
```

**Graceful shutdown**:

```typescript
process.on("SIGTERM", async () => {
  await Promise.all(workers.map((w) => w.close()));
});
```

**Error handling patterns**:

| Error Type      | Worker Behavior                                    | Example                              |
| --------------- | -------------------------------------------------- | ------------------------------------ |
| Transient error | Throw → BullMQ retries with backoff                | Network timeout, 503 API error       |
| Permanent error | Throw `UnrecoverableError` → no retry, move to DLQ | 401 auth error, missing step handler |
| State error     | Clean exit (return) → job completes without retry  | Execution already completed/failed   |

**Retry policies** (per queue):

- `calendar-sync`: 8 attempts, 30s exponential backoff
- `triggers`: 8 attempts, 5s exponential backoff
- `workflow`: 12 attempts, 5s exponential backoff, 15-minute cap
- Others: default BullMQ (3 attempts, exponential)

---

### 17.5 Worker-to-Service Interaction

Workers **orchestrate** but services **execute**:

```
Worker (processor)     →  Service              →  External API / DB
─────────────────────     ───────────           ──────────────────
calendarSync.processor → sync.ts               → Google Calendar API
triggers.processor     → (direct DB queries)   → workflows table
workflow.processor     → engine.ts → registry  → step handlers (AI, email, etc.)
conflicts.processor    → conflicts.service.ts  → events table (SQL detection)
notifications.processor→ notification.service  → FCM + Gmail
email.processor        → email.service         → Gmail API
dlq.processor          → (audit only)          → audit_log table
```

**Separation of concerns**:

- **Workers**: job lifecycle, retry management, state transitions, audit logging
- **Services**: business logic, API calls, data persistence

---

### 17.6 Monitoring and Debugging

**Logs**:
All workers log to console with structured format:

```
[<queue-name>] <job-type> | <context> | job=<jobId>
```

**Example**:

```
[calendar-sync] google.sync | user=uuid | channel=ch123 | job=job456
[triggers] trigger.emit | calendar.event.upserted | user=uuid | fanned out to 2 workflow(s)
[workflow] workflow.run | execution=exec-uuid step=generate_email attempt=0 | job=job789
```

**BullMQ dashboard** (if installed):

- View queue depths, job statuses, retries
- Inspect failed jobs with full stack traces
- Manually retry/delete jobs

**Audit logs**:
Query `audit_log` table for durable records of worker actions:

```sql
SELECT * FROM audit_log WHERE actor_type = 'worker' ORDER BY created_at DESC LIMIT 100;
```

---

### 17.7 Extension Guidelines

**Adding a new worker**:

1. Create `src/workers/processors/myQueue.processor.ts`:
   ```typescript
   export function startMyQueueWorker(): Worker {
     return new Worker(
       "my-queue",
       async (job) => {
         const envelope = JobEnvelopeSchema.parse(job.data);
         // ... handle job types
       },
       { connection: getConnection(), concurrency: 5 },
     );
   }
   ```
2. Register in `src/workers/index.ts`:
   ```typescript
   import { startMyQueueWorker } from "./processors/myQueue.processor";
   export function startAllWorkers(): Worker[] {
     return [
       // ... existing workers
       startMyQueueWorker(),
     ];
   }
   ```
3. Create queue getter in `src/queues/queues.ts`
4. Enqueue jobs from services/routes

**Adding a new job type to existing worker**:

1. Add job type constant to `src/jobs/schemas/envelope.ts`
2. Add case to worker's switch statement
3. Implement handler logic (call service function)

---

### 17.8 Current Gaps and TODOs

- **Microsoft sync**: `calendar-sync` worker has placeholders for Microsoft Graph (Step 14)
- **Email queue**: not wired from workflow steps yet (email drafts work synchronously)
- **Multi-device push**: notifications worker only targets first device token
- **DLQ replay**: no automated retry mechanism (manual intervention required)
- **Workflow step timeout**: timeout jobs not yet enqueued by any step handler

---

## 18. Workflow Folder (`src/workflow`)

The workflow folder contains the **execution engine and step registry** that drives the workflow automation system. It defines what steps exist, how they execute, and how the execution state machine advances.

### 18.1 Overview

Workflows are user-defined automations triggered by calendar events or conflicts. Each workflow consists of a **sequence of steps** (or conditional branches) that:

- Generate AI email drafts
- Send/draft calendar events
- Wait for user input or time
- Branch on conditions from previous steps
- Notify users

The workflow folder provides:

- **Type-safe step schemas** (Zod definitions for every step type)
- **Execution engine** (`runStep`) that invokes step handlers and manages state
- **Step registry** that maps step types to handler functions
- **State machine functions** for transitioning executions between states
- **Built-in step implementations** (wait_until, branch, email generation, etc.)

### 18.2 File Breakdown

---

#### 18.2.1 Definition: [src/workflow/definition.ts](src/workflow/definition.ts)

**Purpose**: Centralized Zod schemas for all workflow step types and the full workflow definition shape.

**Key schemas**:

| Schema                           | Step Type                | Purpose                                           |
| -------------------------------- | ------------------------ | ------------------------------------------------- |
| `LogStepSchema`                  | `log`                    | Emit debug log line                               |
| `NotifyStepSchema`               | `notify`                 | Send push/email notification with actions         |
| `WaitUntilStepSchema`            | `wait_until`             | Pause until fixed timestamp                       |
| `WaitForInputStepSchema`         | `wait_for_input`         | Pause until user action                           |
| `BranchStepSchema`               | `branch`                 | Conditional routing based on context              |
| `AiGenerateEmailStepSchema`      | `ai_generate_email`      | Generate AI email draft (calls AI service inline) |
| `EmailDraftCreateStepSchema`     | `email_draft_create`     | Persist AI output as Gmail draft (inline)         |
| `CalendarRescheduleStepSchema`   | `calendar_reschedule`    | Reschedule a calendar event at the provider       |
| `CalendarDeclineStepSchema`      | `calendar_decline`       | Decline a calendar event at the provider          |
| `EmailGeneratePreviewStepSchema` | `email_generate_preview` | Generate, preview and approve an AI email draft   |
| `EmailSendStepSchema`            | `email_send`             | Send a previously-drafted email                   |

**Additional type details**:

- `AnyWorkflowStepSchema` = the full discriminated union (`WorkflowStepSchema`) **OR** `GenericStepSchema` (catch-all for forward compatibility with unknown step types).
- `GenericStepSchema` matches any object with a `type` string + optional `config`/`id`, allowing newer step types to pass validation without a schema update.

**Workflow definition shape**:

```typescript
{
  trigger: {
    conditions: [
      { field: "event.eventType", op: "equals", value: "meeting" }
    ]
  },
  steps: [
    { id: "step1", type: "log", config: { message: "..." } },
    { id: "step2", type: "notify", config: { title: "...", body: "..." } }
  ]
}
```

---

#### 18.2.2 Registry: [src/workflow/registry.ts](src/workflow/registry.ts)

**Purpose**: Global registry that maps step type strings to handler functions.

**Key types**:

**`StepContext`** — what a handler receives:

```typescript
interface StepContext {
  executionId: string;
  stepId: string;
  stepDefinition: AnyWorkflowStep; // full step definition
  executionContext: Record<string, unknown>; // execution state (trigger + outputs)
  attempt: number; // retry count
  userId: string;
  resumePayload?: Record<string, unknown>; // payload from workflow.resume job
}
```

**`StepResult`** — what a handler returns:

```typescript
interface StepResult {
  output: Record<string, unknown>; // persisted to step.output + context.outputs[stepId]
  nextStepId?: string | null; // override next step (undefined = linear, null = end)
  waitSpec?: WaitSpec; // if present, execution pauses
}
```

**`WaitSpec`** — pause specification:

```typescript
type WaitSpec =
  | { kind: "until"; until: string; timeoutNextStepId?: string }
  | {
      kind: "input";
      timeoutSeconds: number;
      timeoutNextStepId?: string;
      routes: Record<string, string>;
    };
```

**Public API**:

```typescript
function registerStep(type: string, handler: StepHandler): void;
function getHandler(type: string): StepHandler | undefined;
```

**Built-in registrations** (at import time):

_Inline handlers (defined directly in `registry.ts`)_:

- `log` — emits a console log line and returns immediately.
- `notify` — full inline handler: signs HMAC action tokens for each configured action (calls `signActionToken()`), enqueues a `notification.send` job via the notifications queue, returns `waitSpec.kind="input"` so the execution pauses and waits for user input.
- `ai_generate_email` — inline handler: resolves `contextPath` and `recipientPath` from the execution context, calls `generateEmailDraft()` (AI service), persists the output.
- `email_draft_create` — inline handler: resolves `aiOutputPath` and `toPath` from the execution context, calls `createEmailDraft()` (email service); `AuthError` / `ProviderNotConnectedError` are thrown as `UnrecoverableError` (non-retryable permanent failures).

_Imported from `steps/` folder_:

- `wait_until` — pause until timestamp (from `steps/wait_until.ts`)
- `wait_for_input` — pause until user action (from `steps/wait_for_input.ts`)
- `branch` — conditional routing (from `steps/branch.ts`)
- `calendar_reschedule` — reschedule a calendar event at the provider (from `steps/calendar_reschedule.ts`)
- `calendar_decline` — decline a calendar event at the provider (from `steps/calendar_decline.ts`)
- `email_generate_preview` — full AI email generation + preview + approval loop (from `steps/email_generate_preview.ts`)
- `email_send` — send a previously-drafted email (from `steps/email_send.ts`)

---

#### 18.2.3 Engine: [src/workflow/engine.ts](src/workflow/engine.ts)

**Purpose**: Core execution engine that runs a single step and advances the execution state machine.

**Main function**: `async runStep(opts: RunStepOptions): Promise<void>`

**Options**:

```typescript
interface RunStepOptions {
  executionId: string;
  stepId: string;
  attempt: number; // retry count (0 = first attempt)
  userId: string;
  jobIdempotencyKey: string; // for audit logging
  requestId: string; // for audit logging
  resumePayload?: Record<string, unknown>; // from workflow.resume
}
```

**Execution flow** (simplified):

1. **Load & guard**: execution exists, not already completed/failed, step not already completed
2. **Idempotency**: if step is already completed, return early (safe for BullMQ retries)
3. **Lookup**: find step definition in workflow, lookup handler from registry
4. **Transition**: execution pending→running (claim with compare-and-swap DB update)
5. **Execute**: call handler with `StepContext`
6. **Persist**: save step output to `workflow_execution_steps.output` and append to `execution.context.outputs[stepId]`
7. **Advance**: based on handler's `nextStepId`:
   - `undefined` → enqueue next step in linear progression
   - `null` → mark execution completed
   - `string` → enqueue the specified step
   - if `waitSpec` returned: mark execution waiting, schedule delayed resume job

**Error handling**:

- `ExecutionStateError` → clean exit (execution changed state concurrently)
- `UnregisteredStepTypeError` → permanent failure (no handler registered), mark execution failed
- Other exceptions → throw for BullMQ retry

**Key guards**:

- A completed step is **never re-executed** (idempotent for retries)
- Execution state uses **compare-and-swap** (WHERE on current status) to prevent concurrent double-execution
- Context is **append-only** (never replaced, only extended)

---

#### 18.2.4 State: [src/workflow/state.ts](src/workflow/state.ts)

**Purpose**: All database state transitions for executions and steps.

**Execution state transitions**:

```typescript
claimExecutionPending(executionId, firstStepId): bool
  // pending → running, returns true if successful

claimExecutionWaiting(executionId, stepId): bool
  // waiting → running, returns true if successful

advanceExecutionStep(executionId, nextStepId): void
  // running: update current_step (tracking)

markExecutionCompleted(executionId): void
  // running → completed

markExecutionFailed(executionId, reason): void
  // running/pending → failed (reason stored in context._failure)

markExecutionWaiting(executionId, stepId, nextRunAt?): void
  // running → waiting
```

**Step transitions**:

```typescript
markStepRunning(executionId, stepId, attempt, input): void
  // UPSERTs step row with status=running

markStepFailed(executionId, stepId, reason): void
  // UPSERTs step row with status=failed

atomicStepCompletion(executionId, stepId, output, nextStepId?): bool
  // Atomically: UPSERTs step with status=completed, appends output to context
  // Returns true if successful, false if execution was already transitioned
```

**Context updates**:

```typescript
appendStepOutputToContext(executionId, stepId, output): void
  // Safely appends step output into context.outputs[stepId] using jsonb_set
```

**Optimistic concurrency**:

- All execution UPDATEs include `WHERE status = <expected>` to detect concurrent mutations
- If 0 rows are affected, another worker already transitioned the state (treat as idempotent success)
- Step UPSERTs allow BullMQ retries to re-enter cleanly without orphaned rows

---

### 18.3 Built-in Steps

#### 18.3.1 Log Step

**Config**:

```typescript
{ type: "log", config: { message: string, level?: "info" | "warn" | "error" } }
```

**Behavior**: Emits console log and returns immediately.

**Output**:

```typescript
{ logged: true, message: string }
```

---

#### 18.3.2 Wait Until Step (Steps folder: [wait_until.ts](src/workflow/steps/wait_until.ts))

**Config**:

```typescript
{
  type: "wait_until",
  config: {
    until: string;                    // ISO-8601 or dot-path to timestamp
    timeoutNextStepId?: string;       // step to route to on timeout
  }
}
```

**Behavior**:

1. First run: resolves `until` (ISO-8601 or dot-path), returns `waitSpec` with that timestamp
2. Engine schedules delayed `workflow.resume` job for that timestamp
3. When timer fires: handler re-invoked with `resumePayload.resumeReason="timer"`, returns (no wait spec), advances to next step

**Output**:

```typescript
{ waitingUntil: string, delayMs: number }
// (on resume) { resumed: true, resumeReason: string }
```

**Example**:

```typescript
{
  id: "pause",
  type: "wait_until",
  config: {
    until: "outputs.step1.scheduledTime" // dot-path
  }
}
```

---

#### 18.3.3 Wait For Input Step

**Config**:

```typescript
{
  type: "wait_for_input",
  config: {
    timeoutSeconds: number;           // how long to wait
    timeoutNextStepId?: string;       // fallback if no action
    routes: Record<string, string>;   // { actionKey: nextStepId }
  }
}
```

**Behavior**:

1. First run: returns `waitSpec` with timeout, engine enqueues delayed timeout job
2. User taps notification action → `workflow.resume` enqueued with `resumePayload.actionKey`
3. Handler checks `routes[actionKey]` and returns appropriate `nextStepId`

**Output**:

```typescript
{ waiting: true, timeoutSeconds: number }
// (on user action) { resumed: true, actionKey: string, nextStep: string }
```

---

#### 18.3.4 Branch Step (Steps folder: [branch.ts](src/workflow/steps/branch.ts))

**Config**:

```typescript
{
  type: "branch",
  config: {
    routes: Record<string, string>;           // { routeKey: nextStepId }
    rules: Array<{                            // ordered condition rules
      routeKey: string;
      conditions: WorkflowCondition[];       // AND logic
    }>;
    defaultNextStepId?: string;               // fallback if no rule matches
  }
}
```

**Behavior**:

1. If `resumePayload.actionKey` set: use `routes[actionKey]` (user-driven)
2. Otherwise, iterate `rules`, first match's `routeKey` determines `routes[routeKey]`
3. No match: use `defaultNextStepId` or `null` (end workflow)

**Conditions**:

- Field paths use dot-notation: `outputs.step1.emailValid`, `event.eventType`
- Operators: `equals`, `not_equals`, `contains`, `not_contains`, `exists`, `not_exists`
- Case-insensitive by default

**Output**:

```typescript
{ routeKey: string | null, via: "action" | "condition" | "default" }
```

**Example**:

```typescript
{
  id: "decide",
  type: "branch",
  config: {
    rules: [
      {
        routeKey: "high_priority",
        conditions: [
          { field: "event.eventType", op: "equals", value: "meeting" },
          { field: "outputs.step1.severity", op: "equals", value: "high" }
        ]
      }
    ],
    routes: {
      high_priority: "notify_manager",
      default: "log_only"
    },
    defaultNextStepId: "log_only"
  }
}
```

---

#### 18.3.5 Calendar Reschedule Step

**File**: [src/workflow/steps/calendar_reschedule.ts](src/workflow/steps/calendar_reschedule.ts)

**Purpose**: Reschedule a Google Calendar event to a new time slot.

**Config**:

```typescript
{
  type: "calendar_reschedule",
  config: {
    nextStepId?: string;  // override next step (undefined = linear)
  }
}
```

**Resume payload** (from prior `wait_for_input` step):

| Field         | Required | Description                                  |
| ------------- | -------- | -------------------------------------------- |
| `eventId`     | Yes      | Internal DB UUID of the event to reschedule  |
| `startTime`   | Yes      | New start time (ISO-8601)                    |
| `endTime`     | Yes      | New end time (ISO-8601)                      |
| `title`       | No       | Optional new title (defaults to existing)    |
| `description` | No       | Optional new description                     |
| `calendarId`  | No       | Google calendar ID (defaults to `"primary"`) |

**Behavior**:

1. Reads `eventId`, `startTime`, `endTime` from resume payload (submitted by user)
2. Validates that `eventId` is one of the `trigger.conflict.conflictingEvents` UUIDs — prevents acting on an arbitrary unrelated event
3. Loads event from DB and verifies the user is the organizer
4. Calls `patchGoogleEvent()` — real Google Calendar API call with `sendUpdates: "all"` (all attendees notified automatically)
5. Updates local `events` table with new times
6. Calls `clearConflictsByEventId(userId, eventId)` — immediately marks all active conflict rows involving this event as `cleared` in the `conflicts` table (no need to wait for the next worker pass)
7. Returns reschedule result with before/after timestamps

**Output**:

```typescript
{
  eventId: string;
  previousStart: Date;
  previousEnd: Date;
  newStart: string;
  newEnd: string;
  title: string;
  rescheduled: true;
}
```

**Error cases**:

- Missing `eventId`/`startTime`/`endTime` → throws
- `eventId` not in `conflictingEvents` → throws (security guard)
- Event not found for user → throws
- Non-Google provider → throws (Google only)
- User is not organizer → throws

---

#### 18.3.6 Calendar Decline Step

**File**: [src/workflow/steps/calendar_decline.ts](src/workflow/steps/calendar_decline.ts)

**Purpose**: Decline a Google Calendar event on behalf of the user.

**Config**:

```typescript
{
  type: "calendar_decline",
  config: {
    nextStepId?: string;  // override next step (undefined = linear)
  }
}
```

**Resume payload** (from prior `wait_for_input` step):

| Field        | Required | Description                                  |
| ------------ | -------- | -------------------------------------------- |
| `eventId`    | Yes      | Internal DB UUID of the event to decline     |
| `calendarId` | No       | Google calendar ID (defaults to `"primary"`) |

**Behavior**:

1. Reads `eventId` from resume payload
2. Validates that `eventId` is one of the `trigger.conflict.conflictingEvents` UUIDs — prevents declining an arbitrary unrelated event
3. Loads event from DB, verifies it exists and belongs to user
4. Calls `declineGoogleEvent()` — real Google Calendar API call:
   - **Attendee**: patches `responseStatus` to `"declined"`
   - **Sole organizer**: deletes the event entirely
5. Deletes event from local DB (no longer appears in conflict detection)
6. Calls `clearConflictsByEventId(userId, eventId)` — immediately marks all active conflict rows involving this event as `cleared` in the `conflicts` table
7. Returns decline result

**Output**:

```typescript
{
  eventId: string;
  eventTitle: string;
  declined: true;
  organizerEmail: string | null;
}
```

**Error cases**:

- Missing `eventId` → throws
- `eventId` not in `conflictingEvents` → throws (security guard)
- Event not found for user → throws
- Non-Google provider → throws (Google only)

---

#### 18.3.7 AI Generate Email Step

**Purpose**: Generate an email draft using OpenAI (or demo provider) based on conflict/event context.

**Config**:

```typescript
{
  type: "ai_generate_email",
  config: {
    contextPath?: string;    // dot-path to conflict/event summary
    recipientPath?: string;  // dot-path to recipient email hint (passed to AI prompt only)
  }
}
```

**Output**: `{ subject: string, body: string, recipientEmail?: string }`

> This is an inline step (not the recommended path for conflict resolution). Use `email_generate_preview` instead — it adds the preview loop, auto-skip guard, and multi-recipient support.

---

#### 18.3.8 Email Draft Create Step

**Purpose**: Create an email draft in Gmail or Outlook (never auto-sends). Inline step — does not show a preview.

**Config**:

```typescript
{
  type: "email_draft_create",
  config: {
    aiOutputPath?: string;  // dot-path to AI output (subject, body)
    toPath?: string;        // dot-path to recipient email (single address)
  }
}
```

**Output**: `{ emailDraftId: string, providerDraftId: string, provider: string, recipient: string, isNew: boolean }`

> Currently wraps a single address in `recipients: [address]` when calling `createEmailDraft()`. For multi-recipient sends use `email_generate_preview` + `email_send`.

---

#### 18.3.9 Email Generate Preview Step

**File**: [src/workflow/steps/email_generate_preview.ts](src/workflow/steps/email_generate_preview.ts)

**Purpose**: Full AI email generation + interactive preview + approval loop, with automatic multi-recipient resolution and attendee guard.

**Config**:

```typescript
{
  type: "email_generate_preview",
  config: {
    sendNextStepId?: string;      // step to advance to when user sends
    skipNextStepId?: string;      // step to advance to when user skips (or auto-skipped)
    timeoutSeconds?: number;      // wait timeout (default: 86400 = 24h)
    timeoutNextStepId?: string;   // step on timeout
    contextPath?: string;         // dot-path into execution context for AI input
    recipientPath?: string;       // dot-path to a string or string[] to pre-populate recipients
  }
}
```

**Lifecycle**:

1. **Initial invocation** (no `resumePayload`):
   a. Query `events.attendees` for all `conflictingEvents` in the trigger.
   b. Look up the workflow user's email from `users`.
   c. Build `externalAttendees` = all unique attendee emails **excluding the user's own email**.
   d. **If `externalAttendees` is empty**: return `{ skipped: true, skippedReason: "no_external_attendees" }` immediately and route to `skipNextStepId`. **No AI call is made.**
   e. Otherwise: call AI to generate draft, return output + `waitSpec` (kind: `"input"`) so the frontend can display the preview.

2. **Resume with `actionKey: "send_email"`**: return the previously-generated draft with `sendApproved: true`, route to `sendNextStepId`.

3. **Resume with `actionKey: "regenerate_email"`**: call AI again (bumps `regenerateCount` for a fresh idempotency key), return new draft + another `waitSpec` (loops).

4. **Resume with `actionKey: "skip_email"`**: return `{ skipped: true }`, route to `skipNextStepId`.

**Output shape** (when not auto-skipped):

```typescript
{
  emailDraft: { subject: string; body: string };
  aiOutputId: string;
  isFallback: boolean;           // true = AI failed, served template
  model: string;
  provider: string;
  latencyMs: number;
  regenerateCount: number;       // increments with each regeneration
  recipientEmails: string[];     // ALL external attendees (organizer/self excluded)
  recipientEmail: string | null; // DEPRECATED — recipientEmails[0]; kept for backwards compat
}
```

**Output shape** (auto-skipped — no attendees):

```typescript
{
  skipped: true;
  skippedReason: "no_external_attendees";
}
```

**Resume payload fields** (for `regenerate_email`):

| Field             | Type     | Effect                             |
| ----------------- | -------- | ---------------------------------- |
| `tonePreference`  | string   | Merged into AI context             |
| `meetingNotes`    | string   | Merged into AI context             |
| `recipientEmails` | string[] | Override recipient list            |
| `recipientEmail`  | string   | Deprecated single-address override |

---

#### 18.3.10 Email Send Step

**File**: [src/workflow/steps/email_send.ts](src/workflow/steps/email_send.ts)

**Purpose**: Send the approved email draft to all external attendees via Gmail.

**Config**:

```typescript
{
  type: "email_send",
  config: {
    nextStepId?: string;      // override next step
    draftStepId?: string;     // explicit step ID containing the emailDraft output
    recipientPath?: string;   // dot-path resolving to string or string[]
  }
}
```

**Recipient resolution order** (first non-empty wins):

1. `recipientEmails: string[]` from prior step output (`email_generate_preview`)
2. `recipientEmail: string` from prior step output (backwards compat — wrapped in array)
3. `recipientPath` config — resolves dot-path to string or string[]
4. Common flat context keys: `recipientEmail`, `recipient_email`, `to`
5. **Auto-extract from DB**: query `events.attendees` for all `trigger.conflict.conflictingEvents`, merge all attendee emails, look up user's email from `users`, filter out the user's own email

> If the auto-extract path returns empty (no external attendees), the step throws. This should not happen in practice because `email_generate_preview` auto-skips in that case — `email_send` is only reached when there are valid recipients.

**Send behavior**:

- Calls `sendEmail()` from `email.service.ts`
- `email.service.ts` calls `createGmailDraft()` (idempotent) then `sendGmailDraft()` (idempotent)
- MIME `To:` header is `", ".join(recipients)` — all recipients in one email
- Sender is the user's connected Google account
- Persists to `email_drafts` table with `sent_at` timestamp

**Output**:

```typescript
{
  emailDraftId: string;
  providerDraftId: string;
  messageId: string;
  threadId: string;
  provider: "gmail";
  recipients: string[];          // full list of addresses emailed
  recipientEmail: string | null; // DEPRECATED — recipients[0]
  subject: string;
  sent: true;
  alreadySent: boolean;          // true = idempotent no-op (already sent)
}
```

---

### 18.4 Execution Context Structure

The `workflow_executions.context` JSONB column stores execution state:

```typescript
{
  trigger: {
    // Flattened trigger payload
    triggerType: "calendar.event.upserted",
    userId: "...",
    event: { ... },
    wasUpdated: true,
    observedAt: "..."
  },

  outputs: {
    // Each completed step appends here (never replaced)
    step1: { result1: "value", logged: true },
    step2: { emailDraft: { subject: "...", body: "..." } },
    // ...
  },

  _failure?: {
    // If execution failed
    reason: "step handler threw",
    failedAt: "2026-03-04T12:34:56.789Z"
  }
}
```

**Key properties**:

- `trigger`: immutable, set at execution creation
- `outputs`: append-only, keys never replaced
- `_failure`: reserved for failure metadata
- Accessible to handlers via `ctx.executionContext`
- Accessible to conditions via dot-path (e.g., `outputs.step1.field`)

---

### 18.5 Idempotency Guarantees

**Step idempotency**:

```
First attempt (attempt=0)
  → handler runs → step marked running → output persisted

Retry (attempt=1, 2, ...)
  → engine checks: if step already completed, return immediately (skip handler)
  → if step not completed, re-run handler (must be idempotent)
```

**State machine idempotency**:

- All execution state transitions use `WHERE status = <expected>`
- If update affects 0 rows, another worker already transitioned (log and continue)
- Another worker re-running the same job is not an error

**Handler idempotency**:

- Handlers that call external services (AI, email) use idempotency keys (service-level)
- Output is always safe to re-persist (jsonb_set overwrites but content is same)
- Wait specs returning the same timestamp multiple times is safe (BullMQ dedupes resume jobs)

---

### 18.6 Extension: Adding New Step Types

**1. Define schema** in `src/workflow/definition.ts`:

```typescript
const MyStepSchema = z.object({
  id: z.string().min(1),
  type: z.literal("my_step"),
  config: z.object({
    myParam: z.string(),
  }),
});
```

**2. Add to discriminated union** (in same file):

```typescript
export const AnyWorkflowStepSchema = z.discriminatedUnion("type", [
  LogStepSchema,
  // ... other steps
  MyStepSchema,
]);
```

**3. Implement handler** (create `src/workflow/steps/my_step.ts`):

```typescript
import type { StepContext, StepResult } from "../registry";

export async function myStepHandler(ctx: StepContext): Promise<StepResult> {
  const config = ctx.stepDefinition.config as { myParam: string };

  // ... business logic

  if (shouldWait) {
    return {
      output: { ... },
      waitSpec: { kind: "until", until: "..." }
    };
  }

  return {
    output: { myResult: "..." },
    nextStepId: undefined // linear progression
  };
}
```

**4. Register handler** in `src/workflow/registry.ts`:

```typescript
import { myStepHandler } from "./steps/my_step";
registerStep("my_step", myStepHandler);
```

**5. Update worker import** (in `src/workers/processors/workflow.processor.ts`):

```typescript
import "../../workflow/registry"; // triggers all registerStep() calls
```

---

### 18.7 Monitoring and Debugging

**Logs** (from engine and handlers):

```
[engine] Execution {id} already completed — skipping step {stepId}
[workflow:log] execution={id} step={stepId} | {message}
[wait_until] Waiting {delayMs}ms | execution={id} step={stepId} until={timestamp}
[workflow:branch] matched rule routeKey="{key}" → nextStep={nextStepId}
```

**Database inspection**:

```sql
-- View active executions
SELECT id, workflow_id, status, current_step, context FROM workflow_executions
  WHERE status IN ('pending', 'running', 'waiting')
  ORDER BY updated_at DESC;

-- View execution steps
SELECT execution_id, step_id, status, output FROM workflow_execution_steps
  WHERE execution_id = '{executionId}'
  ORDER BY created_at;

-- View execution context (trigger + outputs)
SELECT jsonb_pretty(context) FROM workflow_executions WHERE id = '{executionId}';
```

**Testing handler**:

```typescript
import { myStepHandler } from './workflow/steps/my_step';

const result = await myStepHandler({
  executionId: 'test-exec',
  stepId: 'test-step',
  stepDefinition: { id: 'test-step', type: 'my_step', config: { ... } },
  executionContext: { trigger: { ... }, outputs: { ... } },
  attempt: 0,
  userId: 'test-user',
});
```

---

### 18.8 Current Limitations

- **Step handler not registered**: engine throws `UnregisteredStepTypeError` (unimplemented step types)
- **No distributed wait orchestration**: wait_until jobs are scheduled locally (not persisted across server restarts)
- **Single execution per workflow per time**: no parallel branches (all routes are sequential step progressions)
- **No loop/repeat construct**: workflows are DAGs, not Turing-complete
- **Context size limit**: JSONB column can grow large with many steps — no archival yet
- **Step failures are terminal**: no built-in retry within a workflow (relies on BullMQ job retries)

---

## 19. Job Envelope Schema (`src/jobs/schemas/envelope.ts`)

**Purpose**: Standard wrapper for all BullMQ job payloads, enforcing consistent structure and idempotency tracking across all queue jobs.

### 19.1 JobEnvelope Schema

Every job in every queue must conform to this Zod schema:

```typescript
const JobEnvelopeSchema = z.object({
  jobType: z.string().min(1), // e.g. "workflow.run", "trigger.emit"
  requestId: z.string().uuid(), // trace ID from original HTTP request
  idempotencyKey: z.string().min(1), // dedup key (deterministic or unique)
  userId: z.string().uuid(), // user performing the action
  payload: z.record(z.unknown()).default({}), // job-specific data
});

export type JobEnvelope = z.infer<typeof JobEnvelopeSchema>;
```

### 19.2 JobType Constants

All supported job types are defined as constants:

```typescript
export const JobType = {
  // Calendar sync
  GOOGLE_SYNC: "calendar.google.sync",
  GOOGLE_WATCH_RENEW: "calendar.google.watch.renew",
  MICROSOFT_SYNC: "calendar.microsoft.sync",
  MICROSOFT_SUBSCRIPTION_RENEW: "calendar.microsoft.subscription.renew",

  // Triggers
  TRIGGER_EMIT: "trigger.emit",
  TRIGGER_EVALUATE: "trigger.evaluate",

  // Workflow
  WORKFLOW_RUN: "workflow.run",
  WORKFLOW_RESUME: "workflow.resume",
  WORKFLOW_TIMEOUT: "workflow.timeout",

  // Conflicts
  CONFLICTS_DETECT: "conflicts.detect",

  // Notifications
  NOTIFICATION_SEND: "notification.send",

  // Email
  EMAIL_DRAFT_CREATE: "email.draft.create",
};
```

### 19.3 Usage Pattern

**Enqueueing a job** (from routes/services):

```typescript
import { getWorkflowQueue } from "../queues/queues";
import { JobEnvelopeSchema, JobType } from "../jobs/schemas/envelope";

await getWorkflowQueue().add(
  JobType.WORKFLOW_RUN,
  {
    jobType: JobType.WORKFLOW_RUN,
    requestId: uuidv4(),
    idempotencyKey: `workflow|run|${executionId}`,
    userId: req.user.id,
    payload: {
      executionId,
      stepId,
      attempt: 0,
    },
  } as JobEnvelope,
  { jobId: idempotencyKey },
);
```

**Processing a job** (in workers):

```typescript
const envelope = JobEnvelopeSchema.parse(job.data);
switch (envelope.jobType) {
  case JobType.WORKFLOW_RUN:
    // ... handle it
    break;
}
```

### 19.4 Design Benefits

- **Consistency**: all queues share the same structure (tracing, idempotency, userId)
- **Observability**: `requestId` and `jobType` enable structured logging across queue
- **Idempotency**: `idempotencyKey` prevents duplicate processing when jobs are retried
- **Type safety**: Zod validation catches malformed jobs early
- **Audit trail**: userId always included for access control and audit logs

---

## 20. Middleware Folder (`src/middleware`)

The middleware folder provides **request-level utilities** that intercept HTTP requests before they reach route handlers.

### 20.1 Auth Middleware: [src/middleware/auth.ts](src/middleware/auth.ts)

(Already documented in Section 3 — JWT verification via Supabase JWKS, attaches `req.user`.)

---

### 20.2 Request ID Middleware: [src/middleware/requestId.ts](src/middleware/requestId.ts)

**Purpose**: Generate/extract unique request ID for tracing and bind a request-scoped logger.

**Behavior**:

1. Read `X-Request-ID` header from the incoming request (only this header — not `x-correlation-id`).
2. If not present: generate a new UUID v4.
3. Attach as `req.requestId` (string).
4. Create child logger bound to `{ requestId, method, path }`: stored as `req.log`.
5. Set `X-Request-ID` response header so callers can correlate logs end-to-end.
6. Log `"Request received"` (info level) at request start.
7. On response `finish` event: log `"Request completed"` with `{ statusCode, durationMs }`.

All downstream code can access `req.log` for structured logging automatically linked to this request.

**Usage** (in route handlers):

```typescript
export async function handleRequest(req: AuthenticatedRequest, res: Response) {
  req.log.info("Processing request", { action: "create_event" });
  // All logs from this request will include requestId automatically
}
```

**In workers**: request ID is preserved via `envelope.requestId` and passed to audit logs

---

### 20.3 Rate Limit Middleware: [src/middleware/rateLimit.ts](src/middleware/rateLimit.ts)

**Purpose**: Redis-backed rate limiting for three route groups with different policies.

**Strategy**: Fixed-window counter per (bucket, identifier, window-index)

- Key: `rl:<prefix>:<identifier>:<windowIndex>` where `windowIndex = Math.floor(now / windowMs)`
- INCR and EXPIRE are atomic (via Lua script)
- No race conditions

**Three pre-built limiters**:

| Limiter                   | Route Group                   | Limit   | Per        | Purpose                                       |
| ------------------------- | ----------------------------- | ------- | ---------- | --------------------------------------------- |
| `oauthRateLimit`          | `/api/v1/auth/*`              | 10 req  | 15 minutes | OAuth connect/callback (prevents brute force) |
| `webhookRateLimit`        | `/api/v1/calendar/webhook`    | 120 req | 60 seconds | Google webhook burst protection               |
| `workflowActionRateLimit` | `/api/v1/workflows/actions/*` | 30 req  | 60 seconds | User action spam protection                   |

**Webhook allowlisting** (security):

- Set `RATE_LIMIT_WEBHOOK_ALLOWLIST_IPS` env var as comma-separated IP list
- IPs in allowlist bypass webhook rate limit entirely
- Supports exact IPs (`34.64.4.1`) and CIDR prefixes (`66.249.`)
- Disabled by default (opt-in for security)

**Rate limit exceeded response**:

```json
HTTP 429 Too Many Requests
Retry-After: 60
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 0
```

**Usage** (in routes):

```typescript
router.post("/oauth/connect", oauthRateLimit, authHandler);
router.post("/webhook", webhookRateLimit, webhookHandler);
router.post("/actions/:actionKey", workflowActionRateLimit, actionHandler);
```

---

## 21. Configuration Folder (`src/config`)

Centralized environment-based configuration for external services (database, cache, auth).

### 21.1 Database Config: [src/config/db.ts](src/config/db.ts)

**Purpose**: PostgreSQL connection pool, query execution, and health checks.

**Exports**:

```typescript
function query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
// Execute parameterized SQL, returns rows and rowCount

function getPool(): Pool;
// Access pg.Pool directly for advanced operations

async function testConnection(): Promise<void>;
// Health check — throws if DB unreachable (called at server startup)
```

**Connection string** (`DATABASE_URL`):

- Format: `postgresql://user:password@host:port/database`
- Passwords with special chars must be URL-encoded (e.g., `@` → `%40`)
- Default port: 5432

**Pool settings** (per `src/config/db.ts`):

- Min connections: 2
- Max connections: 10
- Idle timeout: 30 seconds
- Connection timeout: 10 seconds (`connectionTimeoutMillis: 10_000`)
- SSL: enabled with `rejectUnauthorized: false` (Supabase-hosted)
- Slow-query warning: logs a warning for any query exceeding 500 ms

**Health check example** (in server startup):

```typescript
await testConnection(); // throws if fails
console.log("✓ Database connected");
```

---

### 21.2 Redis Config: [src/config/redis.ts](src/config/redis.ts)

**Purpose**: ioredis singleton used for **rate limiting** (fixed-window counters). Separate from the BullMQ connection (see §21.2.1 below).

**Exports**:

```typescript
function getRedis(): Redis;
// Get singleton ioredis client (for rate limiting middleware)

async function testRedisConnection(): Promise<void>;
// Health check — throws if Redis unreachable (called at server startup)
```

**Connection string** (`REDIS_URL`):

- Local: `redis://127.0.0.1:6379`
- Upstash: `rediss://default:<token>@<host>:6379`
- TLS auto-detected from `rediss://` protocol

**Retry behaviour** (rate-limiting client):

- `maxRetriesPerRequest`: 3
- `retryStrategy`: exponential backoff capped at 5,000 ms

**Local Docker Redis**:

```bash
docker run --name interlink-redis -p 6379:6379 redis:7-alpine
```

**Upstash tier limits** (current issue):

- Free tier: 10,000 commands/day
- Business: ~5M commands/day
- Workaround: switch to local Docker Redis for development

---

#### 21.2.1 BullMQ Connection Config: [src/queues/connection.ts](src/queues/connection.ts)

**Purpose**: Connection **options object** (not an ioredis instance) passed to every BullMQ `Worker` and `Queue` constructor.

**Exports**:

```typescript
function getConnection(): RedisOptions;
// Returns BullMQ-compatible RedisOptions object
```

**Key connection options**:

- Parses `REDIS_URL` (splits host/port/auth from URL)
- `keepAlive`: 10,000 ms (prevents silent TCP disconnects)
- `enableReadyCheck`: `false` (required for Upstash and hosted Redis providers)
- `maxRetriesPerRequest`: `null` (BullMQ requirement — must be null)
- `retryStrategy`: exponential backoff capped at **10,000 ms** (higher ceiling than the rate-limiting client)
- TLS auto-detected from `rediss://` prefix

**Usage**:

```typescript
import { getConnection } from "../queues/connection";
new Worker("my-queue", processor, { connection: getConnection() });
new Queue("my-queue", { connection: getConnection() });
```

**Note**: `enableReadyCheck: false` is intentional — Upstash and other hosted providers reject the READY check command.

---

### 21.3 Supabase Client Config: [src/config/supabase.ts](src/config/supabase.ts)

**Purpose**: Thin singleton wrapper that creates and returns the Supabase JS client. Used for storage, realtime, or any Supabase operations that need the client SDK.

**Exports**:

```typescript
function getSupabase(): SupabaseClient;
// Returns a lazily-initialised Supabase client (createClient(SUPABASE_URL, SUPABASE_KEY))
```

**Implementation**: ~22 lines — calls `createClient(url, key)` with `SUPABASE_URL` and `SUPABASE_KEY` environment variables.

**What this file is NOT**:

- It does **not** perform JWT verification.
- It does **not** fetch or cache JWKS.
- JWT verification lives in [src/security/supabaseJwt.ts](src/security/supabaseJwt.ts) (Section 12) using `jose` and `createRemoteJWKSet`.

**Environment variables required**:

- `SUPABASE_URL` — project URL (e.g., `https://<ref>.supabase.co`)
- `SUPABASE_KEY` — service-role or anon key

---

## 22. Observability Folder (`src/observability`)

### 22.1 Structured Logger: [src/observability/logger.ts](src/observability/logger.ts)

**Purpose**: JSON-based structured logging with log levels, context binding, and prettified dev output.

**Log levels** (numeric, lowest to highest):

- `trace` (10) — very detailed debugging
- `debug` (20) — debugging info
- `info` (30) — general information (default)
- `warn` (40) — warnings
- `error` (50) — errors
- `fatal` (60) — fatal/unrecoverable

**Basic usage**:

```typescript
import { logger } from "../observability/logger";

logger.info("Server started", { port: 5000 });
logger.warn("High memory usage", { rss: 500000000 });
logger.error("Request failed", err);
```

**Child logger** (bind context):

```typescript
const reqLog = logger.child({ requestId: "abc-123", userId: "user-456" });
reqLog.info("API call"); // automatically includes requestId, userId
```

**Output formats**:

- **Production** (NODE_ENV=production): newline-delimited JSON to stdout/stderr
- **Development**: prettified with colors and indentation

**Example JSON output**:

```json
{
  "time": "2026-03-04T12:34:56.789Z",
  "level": 30,
  "levelName": "info",
  "requestId": "abc-123",
  "userId": "user-456",
  "msg": "API call",
  "action": "create_event"
}
```

**Configuration** (`LOG_LEVEL` env var):

```bash
LOG_LEVEL=debug npm start    # See debug logs
LOG_LEVEL=warn npm start     # Only warnings and errors
```

**Error logging**:

```typescript
try {
  await someOperation();
} catch (err) {
  logger.error("Operation failed", err);
  // Automatically serializes error.message, error.name, error.stack
}
```

**Security note**: Never log secrets, tokens, or passwords. The logger does **not** scrub automatically.

---

## 23. Express App Setup (`src/app.ts`)

**Purpose**: Configure Express middleware, register routes, and set up error handling.

**Structure**:

1. **Middleware order**:
   - `requestIdMiddleware` (first — enables tracing)
   - `helmet()` (security headers)
   - `cors()` (cross-origin requests)
   - `express.json()` (parse JSON bodies)
   - `express.urlencoded()` (parse form data)

2. **Routes registration**:
   - `/health` — liveness probe
   - `/api/v1/auth/*` — OAuth and login
   - `/api/v1/calendar/*` — calendar sync and webhooks

- `/api/v1/events/*` — event read APIs + decline send flow + send logs query
- `/api/v1/email-templates/*` — decline template management

3. **Error handler** (registered last):
   - Catches all exceptions from routes
   - Converts `AppError` subclasses to HTTP responses
   - Logs unhandled errors

**Key function**: `getApp(): Express`

- Returns configured Express app
- Called by `src/server.ts` (HTTP server) and tests

---

## 24. HTTP Server Startup (`src/server.ts`)

**Purpose**: Parse environment, validate configuration, initialize core services, start Express HTTP server.

**Startup sequence**:

1. Load `.env` file (`dotenv.config()`)
2. Validate required environment variables:
   - `DATABASE_URL`
   - `SUPABASE_URL`, `SUPABASE_KEY`
   - `REDIS_URL`
   - `ENCRYPTION_KEY`
3. Initialize encryption keyring (`initKeyring()`)
4. Test PostgreSQL connection (`testConnection()`)
5. Test Redis connection (`testRedisConnection()`)
6. Start Express on `process.env.PORT` (default 5000)
7. Print startup banner with health/auth/events endpoints

**Error handling**:

- If any validation fails: log error and exit with status 1
- If DB/Redis unreachable: throw and exit

**Example startup output**:

```
🚀 Server running on http://localhost:5000
   Health: http://localhost:5000/health
   Auth:   http://localhost:5000/api/v1/auth/google?token=<JWT>
   Events: http://localhost:5000/api/v1/events
```

---

## 25. Background Worker Startup (`src/worker.ts`)

**Purpose**: Start all BullMQ workers in a separate Node.js process for background job processing.

**Startup sequence**:

1. Force IPv4 DNS resolution (`dns.setDefaultResultOrder("ipv4first")`)
2. Load `.env` file
3. Initialize encryption keyring
4. Start all workers via `startAllWorkers()`:
   - calendar-sync
   - triggers
   - workflow
   - conflicts
   - notifications
   - email
   - dlq
5. Log worker startup with queue count

**Graceful shutdown**:

- On `SIGTERM` or `SIGINT`:
  - Close all workers (stop accepting jobs)
  - Wait for in-flight jobs to complete or timeout
  - Exit with status 0

**Unhandled rejection handling**:

- Catches unhandled promise rejections
- Logs to structured logger (appears in stderr)
- Prevents silent failures

**Usage**:

```bash
# Start API server (HTTP)
npm run dev

# In another terminal, start worker process (background jobs)
npm run worker

# Or run both together with concurrently / foreman
npm run dev:all
```

**Separate processes rationale**:

- Allows horizontal scaling (multiple worker instances)
- API and workers can restart independently
- Resource isolation (CPU/memory per process type)

---

## 26. Email Templates API Contract (`src/routes/emailTemplates.routes.ts`)

This section defines the MVP contract for decline-email templates consumed by Flutter.

### 26.1 System Default Template (Reserved)

- Reserved template ID: `system-default`
- The system default template is **always present** in API responses, even when the user has zero custom templates.
- The system default template is **immutable**:
  - `PATCH /api/v1/email-templates/system-default` → rejected (`400`)
  - `DELETE /api/v1/email-templates/system-default` → rejected (`400`)
- Users can still select it as active default via:
  - `POST /api/v1/email-templates/system-default/set-default`

### 26.2 List Behavior (`GET /api/v1/email-templates`)

- Response always contains one built-in system entry plus zero or more custom entries.
- `isActiveDefault` rules:
  - If any custom template is active, system entry has `isActiveDefault: false`.
  - If no custom template is active, system entry has `isActiveDefault: true`.
- Flutter should treat `id === "system-default"` as read-only UI state.

### 26.3 Effective Default (`GET /api/v1/email-templates/effective-default`)

- Returns the template currently used for decline email composition.
- Response includes:
  - `source: "custom"` when a custom active default exists
  - `source: "system"` when falling back to system default
- When `source` is `system`, `template.id` is always `system-default`.

### 26.4 Flutter Integration Expectations

- Render the system default as a non-editable, non-deletable option.
- Allow edit/delete actions only for custom templates (IDs not equal to `system-default`).
- Allow selecting either custom templates or `system-default` as default.
- For prefill/send flows, call `GET /effective-default` and use that payload directly.

## 27. Decline Send + Logs Contract (`src/routes/events.routes.ts`)

This section defines the MVP contract for one-call decline email sending and explicit send history.

### 27.1 Send Endpoint

- Endpoint: `POST /api/v1/events/:id/send-decline-email`
- Request body:
  - `templateId` (optional, UUID or `system-default`)
  - `customSubject` (optional)
  - `customBody` (optional)
  - `sendToOrganizer` (optional, default true)
  - `sendToAttendees` (optional, default true)
- Behavior:
  - loads event owned by authenticated user
  - resolves recipients from organizer + attendees
  - excludes the authenticated user's own email
  - resolves selected template or effective fallback
  - renders placeholders and sends via Gmail
  - writes explicit send log row for success/failure

### 27.2 Send Log Endpoint

- Endpoint: `GET /api/v1/events/:id/decline-email-logs`
- Purpose: product-facing history for decline email attempts on a specific event.

### 27.3 Send Log Data Model

Table: `email_send_logs` (migration `025_email_send_logs.sql`)

- `id`
- `user_id`
- `event_id`
- `template_id` (nullable)
- `recipients` (jsonb)
- `subject`
- `body`
- `status` (`sent` | `already_sent` | `failed`)
- `gmail_message_id` (nullable)
- `failure_reason` (nullable)
- `created_at`

## 28. MVP Runtime Profile (Non-MVP Isolation)

Current MVP backend runtime is intentionally limited to these mounted route groups:

- `/api/v1/auth`
- `/api/v1/calendar`
- `/api/v1/events`
- `/api/v1/email-templates`

Non-MVP systems (workflows, conflicts, AI, push-tokens/preferences UI path) may still exist in codebase, but they are not required for the MVP backend flow and do not block MVP usage through the mounted route surface above.

## Project Summary

This backend is a TypeScript/Node.js calendar automation system with:

**Core features**:

- ✅ Google Calendar sync (webhooks + polling)
- ✅ Conflict detection (overlaps, buffer violations)
- ✅ AI-powered email draft generation
- ✅ Workflow automation (multi-step execution, wait states, branching)
- ✅ User notifications (FCM push + email fallback)
- ✅ OAuth integration (Google fully implemented, Microsoft placeholders)
- ✅ Rate limiting (webhook, OAuth, user actions)
- ✅ Audit logging (all side effects recorded)

**Architecture**:

- Express HTTP API
- PostgreSQL database
- BullMQ + Redis job queues
- Workflow state machine with step handlers
- Idempotent operations throughout

**Tech stack**:

- Runtime: Node.js + TypeScript
- Web: Express.js
- DB: PostgreSQL (Supabase-hosted in current setup)
- Cache/Queues: Redis (local Docker in dev, Upstash tier limited)
- Auth: Supabase JWT (local JWKS verification)
- OAuth: Google only (Microsoft pending)
- AI: OpenAI or demo provider
- Notifications: Firebase Cloud Messaging

**Key gaps**:

- Microsoft Graph calendar/email not implemented
- Email queue not wired from workflows (drafts work synchronously)
- No multi-device push fan-out (first device only)
- No DLQ job replay mechanism
- Workflow wait_until not persisted across restarts

See individual sections above for detailed API, database schema, worker behavior, and state machine documentation.
