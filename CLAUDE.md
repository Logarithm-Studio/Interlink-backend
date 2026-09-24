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
npm run marketing:schedules # preview required marketing QStash schedules; add -- --apply to create/update
npm run worker:dev   # NO-OP. Jobs run as QStash HTTP callbacks, not a standalone worker.
npm test             # tsx --test — explicit 26-file suite (104 tests as of 2026-09-25)
```

`npm test` runs an explicit **file list**, not a discovered suite. Adding a `*.test.ts` anywhere
does nothing until you append it to the `test` script in
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
Marketing model: read the root [CONTEXT.md](../CONTEXT.md) when changing campaign, content approval,
provider audience, lead attribution, or consent language.

Plain numbered SQL files in [src/db/migrations/](src/db/migrations/) (`001_*.sql` … `091_*.sql`
as of 2026-09-24) applied in filename order by [runner.ts](src/db/migrations/runner.ts) via
`npm run migrate`.
**To change schema, add the next numbered migration file — never edit an applied one.** Note
the history shows a deliberate move off Redis (`034_remove_redis.sql`) toward QStash.

Marketing records are Interlink-owned (`sales_marketing_campaigns`, `sales_marketing_content_items`,
`sales_marketing_approval_events`, `sales_marketing_consent_events`,
  `sales_marketing_contact_attributions`, `sales_marketing_followups`, `sales_marketing_content_revisions`,
  `sales_marketing_external_records`, `sales_marketing_external_sync_events`, and
  `sales_marketing_analytics_snapshots`, `sales_marketing_analytics_refresh_preferences`, `sales_marketing_post_metrics_snapshots`,
  `sales_marketing_activations`, `sales_marketing_social_publish_schedules`, and
  `sales_marketing_activation_events`, `sales_marketing_todoist_preferences`, `sales_marketing_post_monitor_preferences`, `sales_marketing_followup_reminder_preferences`, `sales_marketing_followup_reminder_deliveries`, and `sales_marketing_hubspot_preferences`; migrations `066`–`094`). Migration `087` adds structured campaign goals. Migration `088` adds opt-in HubSpot checks for mapped marketing deals; polling stores property hashes and changed field names only, and provider values still require reviewed import. Migration `089` adds a verified campaign-specific Todoist project override for new follow-up copies. Migration `090` adds opt-in email/push reminder preferences and per-channel delivery records. Migration `091` stores per-user HubSpot pipeline, stage, and representative-owner mappings. Migration `093` stores one-way Notion campaign database exports with explicit property mappings and durable external page IDs; uncertain creates are reconciled against the unique campaign-ID marker before an explicitly confirmed retry; outbound confirmation is bound to the current preview, and reviewed imports can apply only unambiguous configured mappings. Performance compares supported goal targets against available CRM, content, activation, or synced email counts, keeps closed-won value separated by currency, and presents grounded follow-up hypotheses with their evidence; missing provider data is unavailable, not zero. A campaign
brief drafts copy locally, then an explicit app action creates a Mailchimp provider draft. Send and
schedule are separate confirmed actions that re-check provider state; uncertain send/schedule results
stay locked until delayed provider checks confirm the draft is still unsent. If draft creation returns
no provider ID or the request process ends mid-create, recovery verifies the campaign's unique title,
selected audience, and unsent status in Mailchimp before linking it. Mailchimp owns the audience's active subscription and
suppression state. `sales_contacts.marketing_opt_in` is only a user-recorded preference, never a
replacement for provider consent; enabling it requires source and evidence text and has an audit
history. Public form email dedupe is normalized per user under a PostgreSQL transaction lock, while
every submission keeps a separate attribution row. Its intake endpoint uses a shared PostgreSQL
12-per-five-minute IP limit with HMAC fingerprints, 24-hour retention, and a honeypot. Optional
Cloudflare Turnstile is enabled only when both deployment keys are set, and every enabled token is
validated server-side with the form host checked; partial key configuration fails closed. Hosted-form
brand name, headline, description, accent color, HTTPS privacy link, and optional consent copy are
account-configurable. Checked form consent stores the exact displayed copy as local evidence; it never
subscribes a provider audience. Broader
distributed bot detection is not included. Content `planned` is internal calendar state unless a supported
provider and destination are stored by the explicit automatic-publish schedule. Manually recorded
`published` items are user-reported, while direct social publishes use the provider and retain its post
and destination IDs. On-demand post read-back stores up to 40 normalized snapshots per item.
Events can be marked completed as a user-reported outcome. Campaign repurposing saves channel-specific drafts for human review and never publishes them. Marketing lead scores are deterministic, explainable prioritization aids. Migration `085_marketing_followup_reminders.sql` stores per-task reminder times and Notification Hub insertion state. Migration `090_marketing_followup_delivery.sql` adds opt-in email/push preferences and independent per-channel attempts; email goes only to the marketer's connected Google mailbox. Attempts are claimed before provider calls, confirmed failures can be explicitly retried, and uncertain sends require provider checking plus the marketer's explicit non-delivery confirmation before retry.
RLS is enabled and direct Supabase Data API roles are revoked;
the Express backend accesses these records through its PostgreSQL connection.

Migration `069_marketing_revenue_attribution.sql` links deals to exact contacts and campaigns,
adds the campaign performance query, updates a linked lead to `converted` when its deal becomes `won`,
and revokes direct Data API access to sales deals, activities, and contracts. It intentionally leaves
  legacy deals unlinked rather than inferring a contact from display-name text. Gemini Google Search
  research is an on-demand response: return the provided Search Suggestions widget and sources with the
  answer, and do not write grounded results or search suggestions to Interlink storage.

Migration `070_marketing_crm_sync.sql` stores HubSpot contact/deal IDs and sanitized sync outcomes,
not tokens or provider payloads. A marketer previews and confirms a CRM push. A separate on-demand read preview can import selected supported HubSpot fields after a second provider read and fingerprint check; local changes after preview are rejected. Contact matches
use exact normalized email; deals use their saved HubSpot ID or a deterministic description marker for
recovery after an interrupted create. Migration `091_marketing_hubspot_mappings.sql` stores one live
pipeline, explicit Interlink-stage to HubSpot-stage mappings, and local representative to active
HubSpot-owner mappings. The setup API validates IDs against current provider choices and the user's own
roster. Sync previews include the selected IDs and a fingerprint; confirmation must match it, so
local/provider/config changes require a fresh human review. Deal stages and owners can be imported only
through a unique configured mapping. The provider pipeline, selected stage, and mapped owner are shown
before writes.
Do not change subscription/consent fields, send messages, or silently retry an ambiguous provider write.
Inbound imports never change contact email, consent, campaign attribution, or follow-up history. Successful
imports update local records and sanitized reconciliation/activity history atomically; unmappable pipeline
stages or owners remain read-only. A marketer can opt mapped deals into hourly monitoring, which compares hashes
of supported fields, records changed field names, and never imports automatically. The authenticated
`GET /api/v1/marketing/hubspot/conflicts` queue lists at most 100 changed deals using those field names
and links users to the existing fresh-read import preview. `GET /api/v1/marketing/hubspot/resolutions`
lists the 50 latest confirmed reviewed imports by deal and time without returning provider values. HubSpot webhook
subscriptions need customer/app configuration; Salesforce sync still uses the assistant handoff.
Migration `071_marketing_analytics_snapshots.sql` creates user-scoped aggregate
storage; migration `073_marketing_social_analytics.sql` extends it to Facebook Page and Instagram account
insights; migration `076_marketing_stripe_cash_analytics.sql` adds read-only Stripe balance activity;
migration `077_marketing_google_ads_analytics.sql` adds read-only Google Ads campaign performance.
Snapshots are imported on demand from selected connected accounts. GA4 metrics cover
channel-group and session source/medium/campaign breakdowns, separate property totals so unique
users are not added across channels, property-reported total revenue, and an optional top-100 landing-page
report with sessions, key events, and revenue. Landing paths exclude query strings, the report runs
separately so its failure does not discard core GA4 totals, and revenue is provider-reported in the
property's configured currency. Search Console uses final daily totals through dates selected by
the app and does not persist query text. Facebook and Instagram preserve daily account metrics; reach
may count repeat viewers across days. Stripe pages at 100 rows, capped at 1,000 transactions per
refresh, and retains only currency-separated payment/refund totals, payment reversals, failed-refund
returns, fees, net after fees, counts, and pending/available state. Other balance transaction types are excluded; the account-level values do not
represent campaign attribution, bank deposits, recognized revenue, or ROI. Google Ads snapshots are
selected by reportable customer account discovered from the connected account (including manager
subaccounts), use date-filtered GAQL, and retain up to 500 campaign rows with spend micros, clicks,
impressions, configured conversion counts, and conversion value. A capped report marks totals incomplete;
Google Ads conversion values are provider-reported and remain separate from CRM attribution and cash
collected. These snapshots are not an ROI calculation.

Migration `078_marketing_activations.sql` creates campaign-linked event/creator work and a changed-field
history. Store planned/actual cost as two-decimal amounts with an explicit currency; do not aggregate
different currencies together. Reach, engagement, lead, and conversion counters and qualitative outcome
are user-reported and are not verified by a connected provider. The performance dashboard only rolls up
activations that have an explicit campaign link, and must not treat these counts as causal attribution
or cash revenue.
Migration `079_marketing_activation_lead_attribution.sql` links hosted-form touch rows to the exact
activation. The public form validates the activation against its random form-key owner, derives that
activation's campaign, rejects a conflicting campaign parameter, and keeps separate touches even when
an email deduplicates to an existing CRM contact. Once contacts are attributed, changing the activation's
campaign is blocked. The activation list matches touches to deals only by exact `contact_id`, and only
counts deals created on or after that contact's first submission through the activation form. Signed
contracts on those deals are returned by currency. One contact can appear in multiple activations, so
these follow-on CRM outcomes are not causal ROI. Sharing the hosted link measures form submissions, not
visits on an external page; it never changes marketing consent.

Migration `072_marketing_social_publishing.sql` adds `publishing` and `publish_review` states plus the
selected destination to calendar records. Marketers confirm the exact copy and target before Facebook
Page text/link, JPEG/PNG photo, MP4 video, Instagram Business/Creator JPEG/MP4, or LinkedIn member-profile
text/link posts run through Composio. Facebook photo results prefer the composite post ID over the photo
asset ID; Instagram image containers omit the video-only media type. An item is marked published only
when the provider returns a post ID. Timeouts and missing IDs lock the item until the marketer checks
the provider; retry requires separate confirmation that no post exists.
Provider-side scheduling, LinkedIn organization publishing, and YouTube remain on the assistant/handoff
path until account access and read-back are validated. Interlink-owned delayed publishing is available
for approved Facebook, Instagram, and LinkedIn member posts after explicit destination/time confirmation;
it uses migration `092` and the hourly social schedule dispatcher. Migration `074_marketing_todoist_sync.sql`
persists Todoist follow-up task IDs; an explicit per-task check imports a Todoist completion into
Interlink. The check reuses marker-matched legacy copies and searches the provider's most recent 89-day
history. A scheduled dispatcher queues isolated per-user workers to reconcile mapped open tasks hourly;
missing/older tasks stay open for human review. Register the QStash Schedule against
`/api/v1/workers/marketing-todoist-dispatch` in each deployment.
Migration `075_marketing_form_rate_limits.sql` backs the hosted lead form's 12-per-5-minute IP limit
with shared PostgreSQL state across API instances. The database stores an HMAC fingerprint rather
than the IP address, caps the counter, and prunes old buckets after 24 hours. The honeypot stays in
place. Optional Cloudflare Turnstile is configured using both `MARKETING_TURNSTILE_SITE_KEY` and
`MARKETING_TURNSTILE_SECRET_KEY`; it fails closed if only one key is set. The server verifies each
single-use token and matches the returned hostname to the hosted form's request host. Broader
distributed bot detection is not included.

Migration `076_marketing_stripe_cash_analytics.sql` extends the snapshot provider constraint for
Stripe. The endpoint reads `STRIPE_LIST_BALANCE_TRANSACTIONS` through the user's active Composio
connection and saves aggregate metrics only; transaction identifiers and descriptions are not retained.
Migration `077_marketing_google_ads_analytics.sql` adds the `google_ads_campaign` snapshot provider.
The endpoint expands connected Google Ads manager accounts to reportable child accounts, reads a
date-filtered campaign report through `GOOGLEADS_SEARCH_STREAM_GAQL`, and saves only normalized
campaign performance aggregates/details (up to 500 rows). It is read-only; developer-token production
access and account permissions must be configured outside Interlink. Do not present conversion value as
CRM revenue or causal campaign return.

Migration `080_marketing_analytics_refresh_schedule.sql` stores a user's opt-in daily refresh setting, selected connected account references, 30/90-day range, and last provider success/failure names. The authenticated API verifies selected targets at enable time. A daily signed QStash Schedule must call `/api/v1/workers/marketing-analytics-dispatch`; it fans out idempotent per-user refresh jobs, and the worker uses the existing read-only snapshot path with a range ending three UTC days before the run. No credentials or provider payloads are copied into the preference/result record. The dispatcher queues up to 50 users per run; extend the fan-out or schedule before using this as a large-account scheduler.

Migration `081_marketing_post_metrics.sql` stores at most 40 normalized manual read-back snapshots per published social item, plus `provider_checked` audit events. Direct Supabase Data API access stays revoked. Facebook, Instagram, and LinkedIn checks use read-only Composio actions; the service rechecks saved post and destination IDs, rejects posts returned for a different destination when provider owner metadata is present, and does not change local publication state on read errors. Facebook and Instagram count fields depend on provider permissions. LinkedIn member-post read-back confirms availability but does not return engagement counters through the current member-profile action; current share statistics are organization-scoped.

Migration `082_marketing_todoist_project.sql` stores a verified per-user default Todoist project; migration `089_marketing_campaign_todoist_projects.sql` stores a verified campaign override. New follow-up copies use the campaign project, then the account default, then Todoist Inbox. Existing linked tasks are never moved when a mapping changes. Migration `083_marketing_post_monitoring_schedule.sql` stores opt-in social providers and bounded daily monitoring results. The signed daily `/api/v1/workers/marketing-analytics-dispatch` fan-out also queues one post-monitor job per opted-in user; each job checks up to ten posts and stores normalized read-back snapshots only. Migration `084_marketing_lead_assignment.sql` adds a marketing lead owner from the same account's rep roster; the API enforces roster ownership. Migration `085_marketing_followup_reminders.sql` stores per-task reminder times and Notification Hub insertion state. Migration `090_marketing_followup_delivery.sql` stores opt-in push/email preferences and per-channel delivery status. The hourly `/api/v1/workers/marketing-todoist-dispatch` tick queues up to 50 per-user reminder jobs; each handles up to ten due follow-ups, and uncertain sends are not retried automatically.
Migration `092_marketing_social_publish_schedule.sql` stores an approved post's confirmed provider, destination, time, generation, and dispatch state. The marketer can schedule automatic publication for supported Facebook, Instagram, or LinkedIn member posts, then remove a waiting schedule while retaining the approved content. The hourly `/api/v1/workers/marketing-todoist-dispatch` retries pending QStash dispatches; QStash receives only schedules within six days to support its free-tier delay cap. The signed `/api/v1/workers/marketing-social-publish` callback locks content before schedule state and atomically claims both before any provider write. Cancel, unschedule, edit, reschedule, and manual publish invalidate queued generations. If publication is uncertain or a worker stays claimed for 15 minutes, the item moves to `publish_review`; never retry an external post automatically.

  Campaign-to-Notion export creates a user-selected-page snapshot; the title includes the campaign ID
  prefix so repeat requests can find the existing page. Todoist uses API v1 with cursor pagination and
  rotating refresh-token persistence. Marketing follow-ups save the external task ID and stable marker;
  an hourly per-user QStash worker imports completed states from the last 89 days, while missing/older
  tasks stay open. The QStash Schedule must be configured per deployment.

Composio adds curated Marketing integrations (Mailchimp, Kit, Google Analytics, Search Console,
Canva, Stripe, Facebook Pages, Instagram, LinkedIn, YouTube, Google Ads) plus HubSpot/Salesforce. The assistant's connected-app
tool budget is persona-scoped: Sales prioritizes marketing providers and uses a four-tool per-provider
cap within the global 40-tool ceiling. Google Ads connect requires optional
`GOOGLE_ADS_DEVELOPER_TOKEN`; it is configured on the Composio managed auth config.

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
