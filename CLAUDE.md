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
npm test             # tsx --test — two files: professional/spreadsheet + notifications/hubSummary
```

`npm test` runs an explicit **file list**, not a discovered suite (15 tests across two files).
Adding a `*.test.ts` anywhere does nothing until you append it to the `test` script in
`package.json` — that is the single easiest way to write a test that silently never runs.

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
Plain numbered SQL files in [src/db/migrations/](src/db/migrations/) (`001_*.sql` … `061_*.sql`
as of 2026-08-31) applied in filename order by [runner.ts](src/db/migrations/runner.ts) via
`npm run migrate`.
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

**Multi-account (Personal ⟷ Work):** a user can connect several Google accounts. `google_accounts`
is keyed by `id` (not `user_id` — the old `UNIQUE(user_id)` is gone) and carries `email` + `role`
(`personal|professional`) + `is_primary`. `events` and `google_watch_channels` carry
`google_account_id`, so each account has its own calendar sync/watch channel and events are
account-tagged. [auth.service.ts](src/services/auth.service.ts) owns the account resolution:
`resolveGoogleAccount(userId, mode)` (role → primary → most-recent), account-scoped
token helpers (`refreshGoogleTokenForAccount`, etc.), and `upsertGoogleAccountOnConnect` (captures
the real email; adopts legacy NULL-email rows). The app advertises its mode via the
`X-Interlink-Mode` header; `resolveGoogleAccountForRequest`
([src/middleware/googleAccount.ts](src/middleware/googleAccount.ts)) turns it into
`req.googleAccountId` on the google/calendar/events routes. **Legacy `userId`-only Google helpers
still resolve the primary account**, so single-account features are unchanged.

### Email
Two distinct paths: **Gmail API** for decline-email sends (the product feature —
`src/services/email/declineEmail.service.ts`, `gmail.service.ts`, with explicit `email_send_logs`).
The decline path sends from the **event's own** `google_account_id` mailbox (falls back to the
user's primary account), so a Work-calendar event declines from the Work mailbox. And
**SMTP/nodemailer** for transactional OTP email verification
(`src/services/emailVerification.service.ts`). Templates have an immutable reserved
`system-default` (id `system-default`, cannot be edited/deleted, can be set active);
see `src/services/email/templates.service.ts`.

### AI
**Two systems live under `src/services/ai/` — know which one your path uses.**

1. **`geminiClient.ts` — the agent brain, used by BOTH modes.** Gemini REST (no SDK) with
   multimodal `inline_data` + `functionDeclarations`. Everything agentic imports it directly and
   gates on `isGeminiLive()`: `personal-assistant.service.ts`, every professional vertical,
   `agentLoop.ts`, `attachment.service.ts`, `composio.service.ts`. Env: `GEMINI_API_KEY` /
   `GEMINI_MODEL` (default `gemini-2.5-flash`).
2. **`provider.ts` (`getProvider({ mode })`) — the older JSON-text abstraction**, used at only
   three call sites in `ai.service.ts`. Professional mode → Gemini. Personal mode →
   `AI_PROVIDER ?? "openai"`, so **the no-arg `getProvider()` resolves to OpenAI unless
   `AI_PROVIDER=gemini` is set**. Every call site wraps it in try/catch with a deterministic
   template fallback, so a missing `AI_API_KEY` degrades silently rather than erroring — check
   your `.env` before concluding the AI draft feature is broken.

All outputs are JSON-only, temperature 0, Zod-validated, 30s timeout, with deterministic fallbacks.
AI is a supporting feature, not the required MVP path.

Both command centers share `src/services/ai/attachment.service.ts`. It parses spreadsheets and
UTF-8/office documents locally, sends Gemini-supported PDF/image/audio/video formats inline, enforces
a 15 MB raw-file limit, and fails closed for unreadable binary formats. Attached-spreadsheet email
workflows do **not** trust the model to select addresses: the model describes the filter, then
`professional/spreadsheet.service.ts` reapplies date/row filters deterministically and rebuilds the
recipient list exclusively from parsed rows before returning the confirmation action. Ambiguous dates,
invalid date cells, truncated sheets, and sends above the 100-recipient safety cap block before send.

### Notification Hub (`/api/v1/notifications`)
One cross-app queue of things **waiting on the user** — the bell, the "Waiting on you" widget,
and the full notification screen all read from it. Wave 1 shipped 2026-08-31.

- **Tables** (migration `062`): `notification_items` (the feed), `notification_source_cursors`
  (pull-adapter resume points, e.g. Gmail `historyId`), `notification_source_health` (drives the
  staleness warning shown *in the widget* — a hub that has silently stopped ingesting is worse
  than no hub, because the user has stopped checking the real apps).
  This is **not** `notification_deliveries` (migration 017), which is a per-channel delivery audit
  trail keyed to `workflow_executions`.
- **Inclusion bar:** *if the user does nothing, does something bad or slow happen?* If no, it is
  activity, not a notification. Do not relax this — a mirror of nine apps' firehoses is the hassle
  relocated, not removed.
- **`hub.service.ts`** is the core: `upsertItem` (upsert on `(user_id, dedup_key)`; **never
  resurrects a dismissed row**, or every poll would undo every dismissal), `getFeed`,
  `getUnreadCounts`, `recordAction`, plus cursor and health helpers.
- **Dedup keys are provider-scoped, not adapter-scoped** — native and Composio delivery of one
  Gmail message both write `gmail:<threadId>` and collapse into a single row. Where a source table
  itself contains duplicates (it happens — `advisor_compliance_items` had 30 rows for 4 distinct
  items from repeated demo seeding), key on **semantic identity** rather than row id.
- **Ordering is deterministic**: `weight DESC, occurred_at DESC`, no time sections. Weights share
  `dailyDigest.service.ts`'s `DigestLine.weight` vocabulary so the two surfaces can never disagree
  about what matters. AI narrates the list once a day; it never ranks or routes it.
- **Retention is state-based, not age-based** (`hubRetention.service.ts`): resolved/dismissed
  purge at 7d; still-open rows have their encrypted preview stripped at 7d and survive as
  ~300-byte pointers; hard ceiling 30d. An invoice overdue 30 days is exactly what the hub is
  meant to keep holding — age alone was the wrong rule.
- **Preview text is encrypted at rest** via the keyring (`encryptToken`/`decryptToken`), truncated
  to 140 chars. A decrypt failure degrades that one row to no-preview rather than failing the feed.
- **Fan-out rule:** external adapters must enqueue **one QStash job per source per user who
  actually holds that credential** (`credentialHoldersBySource()`), never per active user.
  Fanning out to everyone made most jobs a token lookup and an early return that still cost a
  QStash message: measured live, 50 jobs/hour vs 18: ~1,200/day vs ~432/day. Users whose
  credential is `expired`/`reauth_required` ARE still polled — the adapter is what writes
  `notification_source_health`, and that row renders the Reconnect banner, so skipping them
  would freeze the banner telling them to fix the lapse. Only `revoked` is skipped.
  `/workers/hub-refresh` runs the internal adapter across all users in a single tick only because
  it is pure SQL over tables we already own. Do not copy that shape for API-backed adapters.
- **Every adapter must RECORD a credential failure, never throw it.** Look up and decrypt the
  token *inside* the `try`. `getIntegration` decrypts, so a rotated or missing keyring key throws;
  outside the `try` that escaped the adapter, failed the QStash job, and left
  `notification_source_health` unwritten — the source stalls while the user sees a clean feed,
  which is the exact failure the hub exists to prevent.

- **Sources.** Local adapters (`internal`, `calendar`) read only our own tables and run inline for
  all users. External adapters (`gmail`, `slack`, `github`, `jira`, `todoist`) fan out one job per
  credential-holding user per source onto the `hub` queue → `hub.processor.ts`. Composio webhooks write to the hub too
  (`composioTriggers` no longer pushes — same event, same behaviour, whichever way the account was
  connected).
  - **Gmail** is a *pull* adapter using a search query, not `history.list`: the query
    `is:unread in:inbox newer_than:7d -category:promotions/social/updates` expresses the actionable
    bar AND doubles as inferred resolution (anything that stops coming back was handled elsewhere).
  - **GitHub** uses `GET /notifications` and filters on the `reason` field — only
    `review_requested`/`assign`/`mention`/`team_mention` are things a person is blocked on.
    Honour the `X-Poll-Interval` it returns.
  - **Todoist** includes only tasks due **today or earlier**; an undated task is a personal
    backlog, not something waiting on the user, and letting them in would drown real items.
    `selectActionableTasks()` is pure and unit-tested because the one live token is encrypted
    under a production-only keyring key, so the adapter cannot be run end to end locally. Note
    Todoist returns `2026-08-31T09:00:00` for timed tasks — compare the date part, or a task due
    at 09:00 today reads as future and is silently dropped.
  - **Slack** needs `im:read`/`im:history`/`search:read`, which tokens granted before 2026-08-31
    lack; `hasHubScopes()` detects that and reports `reauth_required` instead of an empty feed.
  - **Listing views** (`re_listing_views`, migration `063`) are the Real Estate persona's own
    signal — Composio has no Zillow/AppFolio toolkit, but we host the page. Coarse by design:
    listing + day + count, nothing identifying, because that page's viewers agreed to nothing.
- **The daily summary** (`hubSummary.service.ts`) is generated once per user per day, cached in
  `ai_outputs`, and shared with the digest. The model **narrates a computed tally** — it is handed
  exact counts and told not to count, because asking it to tally a 15-line list produced "five
  compliance reviews" against four actual items. Same trust boundary as the spreadsheet email
  flow: the model phrases, the code counts. `thinkingBudget: 0` and a response schema are both
  load-bearing (2.5 thinking models draw thinking tokens from `maxOutputTokens`, and at 200 the
  model thought itself out of room and returned a truncated preamble).
- **Active users** for the scheduler are those with a connected account or professional data —
  **not** `push_tokens`, which is empty in this deployment. `runDailyDigestForAllUsers` uses
  push_tokens and therefore currently reaches nobody; do not copy that proxy.

- **Inline reply** (`hubReply.service.ts`, `POST /:id/draft-reply` + `POST /:id/send-reply`) is
  two steps on purpose: the model proposes, the user edits, and `sendReply` sends the body the
  client passes back — it never regenerates. One-tap send of model-written text to a real
  colleague is what gets a feature switched off after a single bad send. Sending resolves the
  item (an inline action for the metric); the client must NOT also call dismiss, or it overwrites
  `resolved` and corrupts the ratio.
- **Composio alert triggers are verified, and most toolkits cannot be wired.** `quickbooks`,
  `xero` and `docusign` expose **no triggers at all**; `linear` and `asana` have only
  workspace-wide created/updated events with no "assigned to me". See
  `DELIBERATELY_UNWIRED_TOOLKITS` in `composioTriggers.service.ts` — a toolkit having *tools*
  does not mean it has *triggers*, and `enableEventAlerts` tolerates a bad slug, so a wrong name
  fails silently.

QStash Schedules are **registered** (2026-08-31): `hub-refresh` hourly (`0 * * * *`) and
`hub-retention` daily (`45 3 * * *`), both against `https://interlink-backend.vercel.app` —
matching the existing three. Note `API_BASE_URL` in `.env` is an ngrok tunnel for local dev and
must never be used as a schedule destination.

### Composio — the brokered long tail of integrations
[composio.service.ts](src/services/composio/composio.service.ts) + `/api/v1/composio/*`
([composio.routes.ts](src/routes/composio.routes.ts)). One `COMPOSIO_API_KEY` unlocks HubSpot,
Salesforce, Stripe, Zendesk, Intercom, QuickBooks, Linear, Asana, Greenhouse, DocuSign, Mailchimp,
Zoom, Calendly, Dropbox, Airtable, Telegram, Discord, Canvas — Composio owns the OAuth apps
for most, so **we register no OAuth app and store no tokens** (`composio_connections`, migration
`060`, holds only a pointer). Setup + costs: [doc/composio-setup.md](doc/composio-setup.md).

**Bring-your-own-credentials.** A toolkit can authenticate against *our own* registered app rather
than a Composio-managed one — **Canvas** (`CANVAS_CLIENT_ID/SECRET`). `getOrCreateAuthConfig()`
creates a custom-auth config from those env vars (`BYOC_CREDENTIALS` map); unset → the toolkit
degrades to a "not supported yet" notice.

**Music = YouTube Music, not Spotify.** Spotify was removed entirely (it needed the user's Spotify
Premium + Extended Quota Mode, so it never worked in the demo). Music now runs on the native
**YouTube Music** integration ([google/youtube.service.ts](src/services/google/youtube.service.ts)),
which rides the shared Google OAuth `youtube` scope — search + playlists work; the app opens a
`music.youtube.com` link to play (the YouTube API has no server-side playback control).

**Otherwise strictly additive.** The remaining native integrations (Google, Slack, Notion, Jira,
GitHub, Trello, Todoist, Microsoft) are untouched: they are deeper than a generic connector and cost
zero metered Composio calls. Composio is a second tool source on the same agent loop.

Four things worth knowing before touching it:
- **Tool budget.** Gemini function-calling degrades past a few dozen declarations. Tools are loaded
  only for the toolkits a user actually connected, capped (40 total / 12 per toolkit) and cached
  5 min. Never load the whole catalog.
- **Schema sanitizer.** `toGeminiSchema()` is load-bearing: Composio emits full JSON Schema and
  Gemini accepts only an OpenAPI-3.0 subset, so one unsanitized connector schema HTTP-400s the
  entire turn — including every native tool in the same request.
- **Naming is the dispatch key.** Composio slugs are `UPPER_SNAKE` (`HUBSPOT_CREATE_CONTACT`);
  native tools are `lower_snake` (`send_gmail`). `isComposioToolName()` routes on that in the
  `default:` arm of both `executeAction` switches.
- **Read-only defaults to WRITE.** Only `GET_/LIST_/SEARCH_/…` verbs auto-chain; anything else goes
  through confirm-before-execute. Deliberate — auto-running an unknown `STRIPE_CREATE_REFUND` is not
  an acceptable failure mode.

With `COMPOSIO_API_KEY` unset every function degrades to empty/not-connected and the assistant
behaves exactly as before (same contract as `rentcast.service.ts`).

### Professional Mode — Financial Advisor (finance persona)
The `finance` persona is branded **Financial Advisor** (label/copy only — the persona key, routes, and
tables stay `finance`/`accountant*`). On top of the AR/expense engine it has an advisory book:
[advisor.service.ts](src/services/accountant/advisor.service.ts) over `advisor_clients` / `advisor_holdings`
/ `advisor_compliance_items` (migration `059`). Portfolio analysis is **deterministic** (allocation vs.
risk-profile target + drift) and folded into the finance agent's snapshot in
[assistant.service.ts](src/services/accountant/assistant.service.ts) `buildSnapshot`, so the agent *answers*
portfolio/compliance questions with no tool call. The action tools (`prepare_meeting_packet`,
`send_client_update`, `resolve_compliance`) live in [agentTools.ts](src/services/ai/prompts/agentTools.ts)
and dispatch in the same `executeAction` switch as dunning/tax. REST surface: `/accountant/advisor/*`;
demo data seeds via the existing `/accountant/seed-demo`.

### Professional verticals — external data
Non-finance personas register a `PersonaVertical` in
[professional/registry.ts](src/services/professional/registry.ts). Two carry live external data:
**Real Estate** `search_market` prefers RentCast (`RENTCAST_API_KEY`) → RapidAPI Realtor
(`RAPIDAPI_KEY`) → **SimplyRETS** ([simplyrets.service.ts](src/services/professional/realestate/simplyrets.service.ts)),
the keyless default that returns realistic demo MLS listings (Houston, TX) with no setup — so listing
search works out of the box. `market_report` uses RentCast or free US Census; `match_buyers` matches
the user's OWN leads (seeded/added, not from a listings API) to their listings locally.

**Marketing a listing is hosting, not syndication.** Publishing to Zillow/an MLS requires broker
licensing + MLS membership — no API key gets past that — so listings are marketed from our own
infrastructure via
[listingPhotos.service.ts](src/services/professional/realestate/listingPhotos.service.ts): photos in
the public Supabase Storage bucket `listing-photos` (free tier; 5 MB, jpeg/png/webp enforced at the
bucket) recorded on `re_listings.photos`, plus a **random** `share_slug` backing an unauthenticated
page at `GET /l/:slug` ([publicListing.routes.ts](src/routes/publicListing.routes.ts), mounted
outside `/api/v1`). The slug is random rather than the listing id because the page is public — ids
must not be enumerable and `user_id` must not appear in an emailed link. That route sets its **own
CSP**: helmet's default `img-src 'self' data:` blocks the Supabase photos, which is the entire point
of the page. The `send_listing_to_buyer` tool publishes (idempotent) + emails the link. Share URLs
resolve `PUBLIC_BASE_URL` → Vercel's `VERCEL_PROJECT_PRODUCTION_URL` → `API_BASE_URL`, deliberately
**not** `API_BASE_URL` first: it is often an ngrok tunnel, and these links live in customers' inboxes. **Product Manager**
[pm.vertical.ts](src/services/professional/pm/pm.vertical.ts) auto-syncs recent GitHub commits/merged PRs
(`getRecentCommits`) + recently-updated Jira issues into its snapshot for contribution tracking
(`contribution_summary`), reusing the already-wired GitHub/Jira OAuth (no new credentials).

## Conventions
- TypeScript `strict` is on; `npm run lint` (tsc --noEmit) must pass.
- Errors: throw the typed errors in [src/utils/errors.ts](src/utils/errors.ts)
  (`UnauthorizedError`, etc.); the global `errorHandler` (registered last in `app.ts`) shapes responses.
- Validate external input with **Zod**.
- Use `req.log` / the `src/observability/logger.ts` logger, not bare `console` in request paths.
