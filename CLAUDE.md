# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Express + TypeScript API for Interlink. See the repo-root [../CLAUDE.md](../CLAUDE.md) for how
this connects to the app, and [API.md](API.md) for the full, code-accurate endpoint reference +
cURL tests. (The old `mvp-*.md` / `GEMINI.md` docs were removed — they described a Flutter
client and a Redis/BullMQ stack that no longer exist.)

## Commands

```bash
npm run dev          # tsx watch src/server.ts — local dev server (port 5000)
npm run build        # tsc → dist/
npm start            # node dist/server.js — run compiled build
npm run lint         # tsc --noEmit — typecheck only; there is no ESLint here
npm run migrate      # tsx src/db/migrations/runner.ts — apply SQL migrations in order
npm run worker:dev   # NO-OP. Jobs run as QStash HTTP callbacks, not a standalone worker.
```

There is **no test runner configured** — do not assume `npm test` exists.

`src/worker.ts` / `npm run worker:start` are intentional no-ops kept only so the Railway
deploy command doesn't crash. All async work is handled by the `/api/v1/workers/*` HTTP
endpoints (see job pipeline below).

## App bootstrap & env

- [src/server.ts](src/server.ts) is the standalone entrypoint: it validates a required-env
  list, calls `initKeyring()`, tests the DB connection, then `app.listen`.
- [src/app.ts](src/app.ts) builds the Express app and **also calls `initKeyring()` itself** —
  because on Vercel the app is imported directly (serverless) without running `server.ts`.
- [vercel.json](vercel.json) rewrites all paths to `/api` (serverless). [railway.json](railway.json)
  runs the (no-op) worker.
- Copy [.env.example](.env.example) to `.env`. Required vars are enforced in `server.ts`
  (DATABASE_URL, SUPABASE_*, ENCRYPTION_KEY, GOOGLE_*, SMTP_*, QSTASH_*, API_BASE_URL, and
  one of EMAIL_VERIFICATION_TOKEN_SECRET / ACTION_SIGNING_SECRET).
- Path alias: `@/*` → `src/*`.
- Middleware order matters: `requestIdMiddleware` is first (attaches `req.requestId` /
  `req.log`), then helmet, cors, `express.json` with a `verify` hook that captures `rawBody`
  for QStash signature verification.

## Architecture

### Layers
Routes (`src/routes/*.routes.ts`) → Services (`src/services/**`) → DB (`src/config/db.ts`).
There is no controllers layer — route files are thin and call services directly. The `query()`
helper in [src/config/db.ts](src/config/db.ts) runs parameterized SQL against a `pg.Pool`
(SSL enabled for Supabase). All data access is **raw SQL** — no ORM.

### Auth
[src/middleware/auth.ts](src/middleware/auth.ts) `authMiddleware` validates the Supabase JWT
via `supabase.auth.getUser()`, upserts the user into the local `users` table on every request,
and sets `req.user = { id, email }`. `src/security/supabaseJwt.ts` exists for offline/local JWT
verification paths.

### Database & migrations
Plain numbered SQL files in [src/db/migrations/](src/db/migrations/) (`001_*.sql` … `034_*.sql`)
applied in filename order by [runner.ts](src/db/migrations/runner.ts) via `npm run migrate`.
**To change schema, add the next numbered migration file — never edit an applied one.** Note
the history shows a deliberate move off Redis (`034_remove_redis.sql`) toward QStash.

### Job pipeline (QStash, not BullMQ/Redis)
This is the most important non-obvious system. Async work is dispatched through **Upstash QStash**:

1. Code calls `enqueueJob(queue, envelope, opts)` in
   [src/services/jobQueue.service.ts](src/services/jobQueue.service.ts). This `publishJSON`s an
   HTTP message to QStash targeting `${API_BASE_URL}/api/v1/workers/<queue>`.
2. QStash POSTs the job back to that endpoint. [src/routes/workers.routes.ts](src/routes/workers.routes.ts)
   verifies the `Upstash-Signature` (via `verifyQStash` against `rawBody`) and dispatches to the
   matching processor in [src/workers/processors/](src/workers/processors/).
3. Response code is the retry contract:
   - **200** → delivered/done.
   - **422** (`PermanentJobError` from [src/jobs/errors.ts](src/jobs/errors.ts)) → QStash does NOT retry.
   - **5xx** → transient; QStash retries with backoff (default 5 retries).
4. Idempotency/dedup uses QStash `deduplicationId` (passed as `jobId`).

Queues: `calendar-sync`, `triggers`, `workflow`, `conflicts`, `notifications`, `email`, `dlq`.

### Trigger → workflow fan-out
Calendar/conflict changes call `emitTrigger()` ([src/triggers/emitter.ts](src/triggers/emitter.ts))
which enqueues to the `triggers` queue with a deterministic `jobId` that coalesces duplicate
events within a 60-second bucket (so multiple Google webhooks for one edit cause one evaluation).
The triggers processor fans out to matching `workflows` rows, which drive the conflicts /
notifications / email processors. Trigger payload schemas (Zod) are in
[src/triggers/types.ts](src/triggers/types.ts).

### Google Calendar integration
OAuth connect stores **encrypted** Google tokens (`src/security/crypto.ts` + `keyring.ts`,
keyed by `ENCRYPTION_KEY`). After connect: initial import, then incremental sync driven by
Google **watch channels** + the webhook endpoint, with watch renewal. Sync code lives under
[src/services/calendar/](src/services/calendar/) (`sync.ts`, `google.ts`, `googleWatch.service.ts`,
`googleSyncCursor.service.ts`, `normalizer.ts`).

### Email
Two distinct paths: **Gmail API** for decline-email sends (the product feature —
`src/services/email/declineEmail.service.ts`, `gmail.service.ts`, with explicit `email_send_logs`),
and **SMTP/nodemailer** for transactional OTP email verification
(`src/services/emailVerification.service.ts`). Templates have an immutable reserved
`system-default` (id `system-default`, cannot be edited/deleted, can be set active);
see `src/services/email/templates.service.ts`.

### AI
`src/services/ai/` wraps OpenAI (`openai` SDK) with Zod-validated outputs and prompt modules
(e.g. `prompts/emailConflict.ts`). AI is a supporting feature, not the required MVP path.

## Conventions
- TypeScript `strict` is on; `npm run lint` (tsc --noEmit) must pass.
- Errors: throw the typed errors in [src/utils/errors.ts](src/utils/errors.ts)
  (`UnauthorizedError`, etc.); the global `errorHandler` (registered last in `app.ts`) shapes responses.
- Validate external input with **Zod**.
- Use `req.log` / the `src/observability/logger.ts` logger, not bare `console` in request paths.
