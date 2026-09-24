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

## Endpoint map (PARTIAL — from `src/app.ts` + route files)

> ⚠️ This map documents roughly a third of the mounted route groups. `src/app.ts` mounts ~28
> (including `/settings`, `/tasks`, `/weather`, `/fitness`, `/notion`, `/todoist`, `/microsoft`,
> `/slack`, `/jira`, `/hr`, `/sales`, `/personal-assistant`, `/preferences`, `/push-tokens`).
> **Absence from this file does not mean an endpoint doesn't exist** — check `src/app.ts` and the
> matching `*.routes.ts`.

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
| POST | `/reports/flash/slack` | Push the flash report to Slack (`{ channel? }`; gated on Slack connected) |
| POST | `/reports/flash/notion` | Export the flash report as a Notion page (`{ parentId? }`; gated on Notion connected) |
| POST | `/invoices/import/notion` | Import invoices from a Notion database (`{ databaseId }`; gated on Notion connected) |
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

**Iteration 3 — autonomy, agentic command center, tax, receipt vision:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/automations` | Automation rules (autonomy + guardrails) + per-client settings |
| PUT | `/automations/:type` | Set `{ enabled?, autonomy:'off'\|'suggest'\|'auto', config?, guardrails? }` |
| POST | `/automations/run-now` | Run the caller's due automations now (testing) |
| PUT | `/clients/:clientName/dunning` | `{ paused }` — pause/resume automated dunning for a client |
| GET | `/activity` | Agent activity feed (incl. `suggested` items awaiting approval) |
| POST | `/activity/:id/approve` | Execute a suggested item |
| POST | `/activity/:id/dismiss` | Dismiss a suggested item |
| POST | `/assistant/command` | Agentic command → answer/action. Supports `{ message, conversationId?, attachmentBase64?, attachmentMimeType?, attachmentName?, clientNow?, tz? }` |
| POST | `/assistant/execute` | Execute a confirmed action. Supports `{ name, args, tz?, attachmentBase64?, attachmentMimeType?, attachmentName? }` |
| POST | `/assistant/transcribe` | Voice → text (`{ audioBase64, mimeType? }` → Gemini audio) |
| GET | `/tax/contractors` | Contractors + `needsW9` flag |
| POST | `/tax/contractors/:id/request-w9` | AI-draft + send a W-9 request; mark `requested` |
| POST | `/tax/contractors/:id/status` | `{ status:'missing'\|'requested'\|'received'\|'filed' }` |
| POST | `/expenses/scan-receipt` | Gemini-vision receipt OCR (`{ imageBase64 }`) → pending expense |

Internal: `POST /api/v1/workers/accountant-automations` (QStash-signed) runs the daily global
autonomy tick. Autonomy honors guardrails (daily send cap, business-hours, per-client opt-out,
escalation capped at "final"); `suggest` queues approvals, `auto` acts directly.

### `/api/v1/professional` — real-estate listing photos & public pages

Marketing surface for the Real Estate persona. Syndicating to Zillow/an MLS needs broker
credentials, so a listing is instead given photos (public Supabase Storage bucket
`listing-photos`) and its own public page to email to buyers.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/listings` | The caller's listings, incl. `photos[]` + `shareSlug` |
| POST | `/listings/:id/photos` | Upload one image — `{ base64, contentType? }`; `base64` may be a bare payload or a `data:image/…;base64,…` URL. Max 5 MB, jpeg/png/webp, 12 per listing → `{ photos, shareUrl }` |
| DELETE | `/listings/:id/photos` | `{ url }` — drop a photo and delete the stored object |
| POST | `/listings/:id/publish` | Idempotent: create (or return) the public page → `{ shareUrl, slug }` |
| DELETE | `/listings/:id/publish` | Take the public page down (link starts 404ing) |

Plus the **public, unauthenticated** page itself, deliberately mounted outside `/api/v1`
because buyers open it in a browser from an emailed link:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/l/:slug` | Server-rendered listing page (photos, price, specs, mailto the agent). 404s once unpublished. |

```bash
# Upload a photo, publish, and open the public page
curl -s -X POST "$API/api/v1/professional/listings/$LID/photos" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"base64":"<png-base64>","contentType":"image/png"}'
curl -s -X POST "$API/api/v1/professional/listings/$LID/publish" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{}'   # → { "shareUrl": "https://…/l/<slug>", "slug": "…" }
curl -s "$API/l/<slug>"                          # no auth
```

The agent tool `send_listing_to_buyer` (`POST /professional/action`) chains publish + Gmail:
`{"name":"send_listing_to_buyer","args":{"name":"<lead>","address":"<listing>","note":"…"}}`.

### `/api/v1/pm` (Professional Mode — Product Manager: GitHub · Trello · Jira · Notion · Slack)

OAuth + CRUD for GitHub/Trello plus the PM PRD workflow dashboard. All workflow actions are
**gated on the relevant integration being connected** and return a friendly "connect X" message
otherwise.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/overview` | Connection status (`github/jira/notion/slack/trello`) + repos + Jira projects |
| GET | `/jira/projects` | Jira projects for the project picker |
| GET | `/notion/prd-pages?q=` | Search Notion pages (PRD / baseline-scope pickers) |
| GET | `/slack/channels` | Slack channels for the alert/publish picker |
| POST | `/workflows/:name` | Run a PRD workflow; `:name` ∈ `prd_to_tickets`, `sprint_interruption`, `release_notes`, `status_sync`, `scope_creep_check` |
| GET | `/repos`, `/boards`, `/standup/:owner/:repo`, … | GitHub/Trello reads + standup/sprint-plan (unchanged) |

Workflow bodies (JSON): `prd_to_tickets` `{ notionPageId\|notionPageQuery, projectKey? }`;
`sprint_interruption` `{ defect\|slackChannel, alertChannel, projectKey? }`;
`release_notes` `{ repo, slackChannel?, notionParentId? }`;
`status_sync` `{ repo?, slackChannel?, notionParentId? }`;
`scope_creep_check` `{ amendmentText, baselinePageId\|baselineQuery\|baselineText }`.

Sales exposes the same pattern via three agent tools (`sync_pipeline_to_trello`,
`import_from_trello`, `post_pipeline_to_slack`) invoked through `POST /api/v1/professional/action`.

### `/api/v1/composio` (brokered integrations — HubSpot, Stripe, Linear, Zoom, …)
One `COMPOSIO_API_KEY` unlocks the whole catalog; Composio owns the OAuth apps, so there is **no
per-vendor client id/secret and no app-side code exchange**. See [doc/composio-setup.md](doc/composio-setup.md).

- `GET /toolkits` → `{ available, toolkits: [{ slug, name, description, audience, status }] }`.
  `available: false` means the server has no Composio key. `status` is
  `disconnected|pending|active|failed|revoked`.
- `POST /connect` `{ toolkit }` → `{ redirectUrl }` — the Composio-hosted consent URL to open.
  `503` when Composio isn't configured; `400` for an unknown toolkit slug.
- `GET /connections` → `{ connections }` — **reconciles against Composio**, so this is the call that
  flips a connection `pending` → `active`. The app polls it after the browser consent step.
- `DELETE /connections/:toolkit` → `{ ok: true }` — revokes upstream at Composio, then marks the row
  revoked locally.
- `GET /callback` — public (no auth), no code exchange; just deep-links the browser back into the app.

Connected toolkits' tools are merged into **both** command centers automatically (`UPPER_SNAKE`
slugs like `HUBSPOT_CREATE_CONTACT`), scoped to connected toolkits and capped at 40 tools.

### `/api/v1/sales/campaigns` (Marketing campaign review)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/sales/campaigns` | Lists the user's briefs and provider state. |
| POST | `/api/v1/sales/campaigns` | Body `{ topic, audience?, objective?, offer?, successMetric?, goalMetric?, goalTarget?, goalCurrency?, channels?, startDate?, endDate?, budgetCents? }`; saves a structured brief and generated email copy, never sends or spends. A numeric goal compares against supported CRM, content, activation, or Mailchimp metrics; `closed_won_value` uses integer minor units and requires an uppercase three-letter currency. |
| PATCH | `/api/v1/sales/campaigns/:id` | Edits subject/body/audience and the complete structured goal configuration while the record remains a local draft. Clear all goal fields with `{ goalMetric: null, goalTarget: null, goalCurrency: null }`. |
| GET | `/api/v1/sales/campaigns/mailchimp/audiences` | Lists audiences from the authenticated Mailchimp connection. |
| POST | `/api/v1/sales/campaigns/:id/provider-draft` | Body `{ audienceId, fromName, replyTo }`; creates a Mailchimp regular-campaign draft and records its provider ID. |
| POST | `/api/v1/sales/campaigns/:id/reconcile` | Body `{ providerCampaignId }`; recovers an unknown create only after verifying the unique Interlink title, selected audience, and that Mailchimp still reports an unsent draft. A crashed `provider_creating` request can be recovered after two minutes. |
| POST | `/api/v1/sales/campaigns/:id/send` | Explicit confirmed send; fetches Mailchimp's current send checklist immediately before sending. Ambiguous provider results stay locked through repeated, separated provider checks. |
| POST | `/api/v1/sales/campaigns/:id/schedule` | Body `{ scheduledAt }`; explicit Mailchimp schedule action (at least 15 minutes in the future). |
| POST | `/api/v1/sales/campaigns/:id/unschedule` | Explicitly removes a provider schedule. |
| POST | `/api/v1/sales/campaigns/:id/sync` | Reads provider campaign state and report metrics into Interlink. A single stale `save` response cannot unlock an ambiguous send or schedule retry. |
| GET | `/api/v1/sales/campaigns/:id/history` | Reads campaign approval and external-action audit events. |
| GET | `/api/v1/sales/campaigns/:id/leads` | Returns unique CRM contacts attributed to the campaign and their latest source/UTM metadata; repeat submissions remain separate attribution touches. |
| GET | `/api/v1/sales/form-key` | Authenticated; gets or creates the user's public lead-form key. |
| GET | `/api/v1/sales/inbound-form-settings` | Authenticated; returns the account's hosted-form key and editable brand name, headline, description, accent color, HTTPS privacy link, and optional consent wording. Requires migration 086. |
| PUT | `/api/v1/sales/inbound-form-settings` | Authenticated; saves those form settings. Requires migration 086. |
| GET | `/api/v1/sales/inbound/:formKey` | Public hosted lead form with the owner's configured copy and styling. Accepts `campaignId`, `activationId`, `utm_source`, `utm_medium`, `utm_campaign`, and `utm_content` query values and carries them into the submission. Activation IDs are resolved against the form owner's records. The optional marketing-consent checkbox is unchecked by default. If both optional Turnstile environment keys are configured, the page renders the challenge widget. |
| POST | `/api/v1/sales/inbound/:formKey` | Public lead intake; JSON `{ name, email?, company?, message?, campaignId?, activationId?, utmSource?, utmMedium?, utmCampaign?, utmContent?, landingPage?, referrer?, marketingOptIn?, marketingConsentText?, "cf-turnstile-response"? }`. Normalized email is deduplicated per user under a transaction lock; every submission keeps its own campaign/activation/UTM attribution and inbound activity. A checked permission box requires email plus the exact currently displayed consent wording; Interlink records it locally and does not subscribe the contact to a provider audience. A stale or mismatched activation still captures the lead, without the activation attribution (the campaign is then checked on its own); a valid activation supplies its linked campaign. A shared PostgreSQL throttle allows 12 requests per IP in a rolling five-minute window across API instances; it stores only an HMAC fingerprint, prunes rows after 24 hours, and works with the honeypot. When both `MARKETING_TURNSTILE_SITE_KEY` and `MARKETING_TURNSTILE_SECRET_KEY` are set, Siteverify is mandatory, the token is not stored, and the response hostname must match the form host. If only one key is set, hosted forms fail closed with 503. Requires migrations 075, 079, and 086 plus a configured signing secret. Turnstile is optional; this is not enterprise or distributed botnet detection. |

`PATCH /api/v1/sales/contacts/:id` accepts `marketingOptIn` plus `marketingOptInSource` and `marketingOptInEvidence`; setting the local permission marker to true requires both provenance fields. `GET /api/v1/sales/contacts/:id/marketing-consent` returns its audit history. This local record does not subscribe a contact. Mailchimp remains authoritative for provider audience subscription and suppression. Sending and scheduling require explicit client confirmation.

Apply migrations `064`–`094` before using the campaign, consent, attribution, follow-up, content-revision, revenue-attribution, CRM sync and monitoring, analytics snapshot, direct social publishing, Todoist follow-up sync, shared public-form throttle, Stripe cash analytics, Google Ads analytics, activation, Todoist project preference, social post monitoring, lead assignment, reminders, hosted-form settings, campaign-goal comparison, reminder-delivery, HubSpot-mapping, automatic social publish, campaign Notion export, and tracked activation redirect routes. Migration `069_marketing_revenue_attribution.sql` adds deal contact/campaign links and locks CRM deal, activity, and contract tables behind the Express API. Existing name-only deals are not auto-linked because that could guess the wrong contact or campaign. Migration `070_marketing_crm_sync.sql` adds account-scoped HubSpot contact/deal ID mappings and sanitized sync history. Migration `071_marketing_analytics_snapshots.sql` creates user-scoped snapshot storage; migration `073_marketing_social_analytics.sql` adds Facebook Page and Instagram account snapshots. Migration `072_marketing_social_publishing.sql` adds persisted publishing/review states and selected target metadata so uncertain public writes cannot be retried blindly. Migration `074_marketing_todoist_sync.sql` persists a user-scoped Todoist task ID and last-check time for follow-ups. Migration `075_marketing_form_rate_limits.sql` creates short-lived shared rate-limit buckets containing keyed IP fingerprints, not raw IPs. Migration `076_marketing_stripe_cash_analytics.sql` allows the `stripe_balance` snapshot provider; migration `077_marketing_google_ads_analytics.sql` allows `google_ads_campaign`. Migration `078_marketing_activations.sql` creates campaign-linked event/creator tracking, reported result counts, and change history. Migration `079_marketing_activation_lead_attribution.sql` ties every activation-specific hosted-form submission to its exact activation. Migration `080_marketing_analytics_refresh_schedule.sql` stores user-scoped opt-in daily refresh settings. Migration `081_marketing_post_metrics.sql` stores normalized, user-scoped snapshots from manual read-back checks and adds the audit event. Migration `082_marketing_todoist_project.sql` stores the selected default Todoist project for new follow-up copies. Migration `083_marketing_post_monitoring_schedule.sql` stores opt-in daily provider checks. Migration `084_marketing_lead_assignment.sql` adds an account-roster rep owner to marketing contacts. Migration `085_marketing_followup_reminders.sql` stores each follow-up reminder time and Notification Hub insertion state. Migration `086_marketing_lead_form_settings.sql` stores each account's hosted-form branding, privacy link, and optional consent wording. Migration `087_marketing_campaign_goals.sql` stores one structured integer goal target per campaign; monetary closed-won targets are stored in minor units with an explicit currency. Migration `088_marketing_hubspot_monitoring.sql` adds opt-in read-only monitoring for mapped HubSpot marketing deals; it retains property hashes and changed field names, never provider values. Migration `089_marketing_campaign_todoist_projects.sql` stores an optional campaign-specific Todoist project override; the API checks the selected ID against the connected user's live project list. Migration `090_marketing_followup_delivery.sql` stores opt-in reminder channel preferences and independent delivery attempts. Migration `091_marketing_hubspot_mappings.sql` stores per-user HubSpot pipeline/stage and representative/owner mappings and allows the deal-owner field in read-only change monitoring. Migration `092_marketing_social_publish_schedule.sql` stores durable, generation-bound automatic social publishing schedules. Migration `093_marketing_notion_exports.sql` stores campaign-to-Notion data source mappings and export state. Migration `094_marketing_activation_link_metrics.sql` stores opaque public redirect tokens and UTC daily request counts without visitor identifiers. Register signed daily and hourly QStash Schedules for `/api/v1/workers/marketing-analytics-dispatch` and `/api/v1/workers/marketing-todoist-dispatch` respectively; the daily analytics dispatcher also fans out opted-in social post checks. Migrations do not register external schedules. Verify migration state in the target database before release.

Authenticated `/api/v1/sales/*` and `/api/v1/marketing/*` routes reject a malformed `:id` with 400 before any database lookup (every `:id` there is a UUID).

### `/api/v1/marketing/leads` and `/api/v1/marketing/followups`

The authenticated lead workspace lists marketing and inbound contacts, shows a transparent 0–100 prioritization score with its contributing reasons, and lets the marketer control qualification status. The score is a sorting aid, not a conversion prediction.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/marketing/leads` | Returns attributed/inbound CRM leads with source, campaign, status, score, score reasons, and any rep-roster owner. |
| PATCH | `/api/v1/marketing/leads/:id/status` | Body `{ status }`; status is `new`, `qualified`, `following_up`, `nurture`, `converted`, or `disqualified`. |
| PATCH | `/api/v1/marketing/leads/:id/assignment` | Body `{ repId: string|null }`; assigns or clears a lead owner from the authenticated account roster. Lead and rep ownership are validated server-side. Requires migration 084. |
| POST | `/api/v1/marketing/leads/:id/opportunities` | Body `{ title, campaignId?, amountCents?, currency?, closeDate?, notes? }`; creates a qualified sales deal linked to the owned contact and the selected or latest attributed campaign, and writes the CRM activity atomically. A `won` deal marks the linked contact converted. |
| GET | `/api/v1/marketing/hubspot/setup` | Returns the connected account's current deal pipelines/stages and active owners, local sales roster, and saved per-user mappings. Requires migration 091 plus HubSpot pipeline, owner, contact, and deal read scopes. |
| PUT | `/api/v1/marketing/hubspot/setup` | Body `{ pipelineId, stageMappings, ownerMappings }`; validates every selected stage, active owner, and local rep against the live provider/workspace before saving. Won/lost must map to matching closed stages. Requires migration 091. |
| GET | `/api/v1/marketing/hubspot/conflicts` | Returns up to 100 most recently detected monitored deal changes with changed field names only; each item links to the deal's existing compare/import review. Requires migrations 070 and 088. |
| GET | `/api/v1/marketing/hubspot/resolutions` | Returns up to 50 confirmed HubSpot imports for marketing deals, with deal title and time. The history contains no provider field values. Requires migration 070. |
| GET | `/api/v1/marketing/deals/:id/hubspot-preview` | Read-only preview. Matches a contact by exact normalized email, finds a deal by its durable ID or deterministic Interlink recovery marker, and returns the selected pipeline/stage, mapped owner, and contact/deal values plus a confirmation fingerprint. Requires an active HubSpot connection and a mapping for the deal's current stage. |
| POST | `/api/v1/marketing/deals/:id/hubspot-sync` | Body `{ confirmed: true, expectedFingerprint }`; recomputes the preview and rejects it if local, provider, or mapping values changed. Then upserts the contact/deal, applies the configured stage/owner, associates records, stores HubSpot IDs, and writes sanitized outcomes. Does not change consent or send email. Requires migrations 070 and 091 plus HubSpot CRM read/write scopes. |
| GET | `/api/v1/marketing/deals/:id/hubspot-monitoring` | Returns whether this mapped marketing deal is eligible for opt-in hourly read-only checks, the last check/error, and supported field names queued for review. Requires migration 088. |
| PUT | `/api/v1/marketing/deals/:id/hubspot-monitoring` | Body `{ enabled: boolean }`; opts this mapped deal into or out of hourly read-only checks. Checks compare property hashes, store only changed field names, and never import automatically. Requires migration 088 and an active HubSpot connection when enabling. |
| GET | `/api/v1/marketing/deals/:id/hubspot-import-preview` | Read-only diff for supported contact and deal fields. Email, consent, campaign attribution, and follow-up history are excluded. Rate-limited. |
| POST | `/api/v1/marketing/deals/:id/hubspot-import` | Body `{ confirmed: true, expectedFingerprint, fields }`; re-reads HubSpot, local values, and mappings, rejects stale previews, and imports only explicitly confirmed supported fields in one transaction. Deal-stage and owner imports require unique configured mappings. Records sanitized CRM events and activity. Unknown pipeline stages or owners are never guessed. |
| GET | `/api/v1/marketing/performance` | All-time campaign funnel and value rollup. Workspace lead totals deduplicate contacts across campaigns; per-campaign counts include every campaign a contact touched. CRM values and user-entered event/creator costs are separated by currency. Campaign-linked activations add status, actual/planned cost, self-reported reach, engagement, lead, and conversion totals, and daily tracked redirect-request totals; these are not provider-verified results or causal ROI. Redirect requests may include bots/previews and are not unique visitors or completed registrations. Planned budgets are not spend; closed-won and signed-contract values are not cash collected. Requires migration 094 for activation redirect metrics. |
| GET | `/api/v1/marketing/activations` | Lists up to 250 Interlink-owned event and creator activations with campaign, owner, deliverables, date, currency-separated costs, link, status, daily redirect-request totals, self-reported result counts, and distinct CRM contacts submitted through the activation's tracked form. Also returns opportunities and won deals linked by exact contact ID and created on or after the first activation submission, open pipeline, won values, and signed contracts by currency. A contact may appear under multiple activations; these follow-on CRM figures are recorded relationships, not causal ROI. Requires migrations 069, 078, 079, and 094 for tracked link metrics. |
| POST | `/api/v1/marketing/activations` | Creates an event or creator activation. Body `{ campaignId?, type: "event"|"influencer", name, owner?, deliverables?, date?, plannedCost?, actualCost?, currency?, url?, outcome?, reach?, engagements?, leads?, conversions?, status? }`. A linked campaign must belong to the authenticated user; costs accept non-negative decimal strings to two places, counters are non-negative whole numbers, and links must use HTTP(S). |
| PATCH | `/api/v1/marketing/activations/:id` | Updates supplied activation fields and writes an audit event listing changed fields. Nullable campaign/date/cost/link/result fields can be explicitly cleared with `null`. |
| GET | `/api/v1/marketing/activations/:id/history` | Returns up to 50 user-scoped creation/update/status events and changed field names. Once an activation has CRM contacts, its campaign link cannot be changed so historical attribution stays intact. |
| POST | `/api/v1/marketing/activations/:id/tracked-link` | Authenticated; creates or reuses an opaque public redirect for the activation's saved HTTP(S) destination and returns its share URL. The backend needs `PUBLIC_BASE_URL`, production `VERCEL_PROJECT_PRODUCTION_URL`, or `API_BASE_URL`. Changing the destination invalidates the old link. Requires migration 094. |
| GET | `/api/v1/marketing/activation-visit/:token` | Public; counts one redirect request in a UTC daily aggregate, then returns a no-store 302 to the activation's saved destination. It stores no IP, referrer, or user agent. Counts may include previews and bots; they are not unique visitors or completed registrations. Requires migration 094. |
| GET | `/api/v1/marketing/performance/analytics-targets` | Lists GA4 properties, Search Console sites, managed Facebook Pages, the connected Instagram professional account, Stripe connection state, and reportable Google Ads customer accounts (expanding manager subaccounts within safety caps). Limited to 30 lookups per user per hour. Google Ads requires an active connection and configured developer token. |
| GET | `/api/v1/marketing/performance/analytics-snapshots` | Returns up to 40 recent user-scoped, normalized provider snapshots. Requires migration 071; social rows also require migration 073; Stripe rows require migration 076; Google Ads rows require migration 077. |
| POST | `/api/v1/marketing/performance/analytics-snapshots` | Body `{ ga4PropertyId?, searchConsoleSite?, facebookPageId?, instagramUserId?, stripeBalance?, googleAdsCustomerId?, startDate, endDate }`; refreshes only selected connected accounts for past ranges up to 90 days. GA4 returns channel-group and session source/medium/campaign breakdowns (capped at 1,000 rows with truncation indicated), separate property totals (so unique users are not summed across channels), property-reported revenue, and a separate top-100 landing-page report with sessions, key events, and revenue by landing path. The landing-page report is optional: if it fails, the channel and property totals still refresh. Page paths omit query strings; revenue uses the GA4 property's reporting currency and instrumentation. Search Console returns final daily clicks/impressions and aggregate CTR/position plus top-100 query and page rows collected with a 500-row cap. Query results can be privacy-suppressed; page paths omit query strings; detailed reports can fail while daily totals still save. Facebook and Instagram return daily account/page insights; Stripe reads up to 1,000 balance transactions and stores currency-separated payment/refund, payment-reversal/refund-return, fee, net-after-fee, and pending/available aggregates; Google Ads reads date-filtered campaign rows for the selected customer ID and stores account-currency spend (micros), clicks, impressions, configured conversions/value, and at most 500 campaign details, marking truncated totals incomplete. GA4 and Google Ads conversion values are provider-reported, not Interlink-attributed leads or cash collected; neither Ads nor Stripe snapshots calculate ROI. Stripe payouts, transfers, disputes, adjustments, and other types are excluded; Stripe totals are not campaign/lead attribution, bank deposits, or recognized revenue. Search Console query phrases are stored in user-scoped aggregate snapshots and may be sensitive; no payment transaction records are stored. Daily reach can repeat viewers across days. Requires migrations 071, 073, and 076/077 as applicable plus the selected connected provider account. |
| GET | `/api/v1/marketing/performance/analytics-refresh` | Returns the user's opt-in daily refresh settings, selected account references, 30/90-day range, and last result. Requires migration 080. |
| PUT | `/api/v1/marketing/performance/analytics-refresh` | Body `{ enabled, rangeDays: 30|90, targets: { ga4PropertyId?, searchConsoleSite?, facebookPageId?, instagramUserId?, stripeBalance?, googleAdsCustomerId? } }`; validates enabled targets against currently connected accounts. A daily QStash worker refreshes selected read-only providers and stores normalized snapshots plus provider success/failure names. The date range ends three UTC days before the run. Requires migration 080 and the deployment QStash Schedule. |
| POST | `/api/v1/marketing/campaigns/:id/research` | Generates a live Gemini Google Search-grounded research session for the owned campaign brief. Returns findings, source links, search queries, and Google's Search Suggestions HTML for display. Limited to 8 requests per user per hour per API instance. The result is not persisted; it requires a configured Gemini key and may use billable API quota. |
| GET | `/api/v1/marketing/campaigns/:id/notion-targets?q=...` | Searches the user's connected Notion pages for a campaign destination. Requires an owned campaign and at least two search characters. |
| POST | `/api/v1/marketing/campaigns/:id/notion` | Body `{ parentId }`; creates or finds a structured Notion copy of the campaign brief and email draft under the selected page. This is a snapshot, not a live sync. |
| GET | `/api/v1/marketing/campaigns/:id/notion-data-sources?q=...` | Searches Notion databases shared with the user's integration using the current data-source API. Returns source/database IDs and names. Requires an owned campaign and at least two search characters. Rate-limited. |
| GET | `/api/v1/marketing/campaigns/:id/notion-data-sources/:sourceId/schema` | Reads the selected data source's property names and types for explicit mapping. Rate-limited. |
| GET | `/api/v1/marketing/campaigns/:id/notion-export` | Returns the durable database export state and external page link, if exported. Requires migration 093. |
| POST | `/api/v1/marketing/campaigns/:id/notion-database` | Body `{ dataSourceId, databaseId, mapping: { campaignId, objective?, audience?, offer?, successMetric?, channels?, startDate?, endDate?, budget? } }`; requires a rich-text campaign ID marker and validates each selected property against the live schema. Creates one campaign row plus a structured brief snapshot. The export mapping and state are persisted before the provider write; an uncertain result is locked for review. Rate-limited. Requires migration 093. |
| POST | `/api/v1/marketing/campaigns/:id/notion-database/reconcile` | Body `{ confirmNoExistingRow?: boolean }`; searches the mapped marker field for this exact campaign ID. A unique match is linked. If none exists, a retry is enabled only after the marketer confirms they checked the destination; multiple matches remain in review. Rate-limited. Requires migration 093. |
| GET | `/api/v1/marketing/campaigns/:id/todoist-project` | Returns the owned campaign's optional Todoist project override and update time. Requires migration 089. |
| PUT | `/api/v1/marketing/campaigns/:id/todoist-project` | Body `{ projectId: string|null }`; verifies a selected non-null project against the user's connected Todoist project list. New follow-up copies use the campaign project, then the account default, then Inbox; existing tasks are never moved. Requires migration 089 and a connected Todoist account when selecting a project. |
| GET | `/api/v1/marketing/followups?status=open` | Returns due-ordered `open`, `completed`, or `cancelled` tasks with contact/campaign context, Todoist task ID, last status-check time, configured reminder time, Notification Hub insertion time, and current reminder delivery status by channel. |
| GET | `/api/v1/marketing/followup-reminder-preferences` | Returns account-level push/email opt-in and channel availability. Email is sent only to the connected Google mailbox; push requires a registered device and configured FCM. Requires migration 090. |
| PUT | `/api/v1/marketing/followup-reminder-preferences` | Body `{ pushEnabled, emailEnabled }`; saves explicit opt-in preferences and rejects enabling an unavailable channel. Requires migration 090. |
| POST | `/api/v1/marketing/followups` | Body `{ contactId, campaignId?, title, dueAt, reminderAt?, notes? }`; due time must be in the future and an optional reminder must be at or before it. Creates an internal task only. |
| PATCH | `/api/v1/marketing/followups/:id` | Body `{ dueAt }`; reschedules an open task. |
| PATCH | `/api/v1/marketing/followups/:id/reminder` | Body `{ reminderAt: ISO-datetime|null }`; configures or clears the task reminder, which is added to the Notification Hub and opted-in channels when due. Rescheduling retains the existing reminder lead time. Requires migrations 085 and 090 for external channel delivery. |
| POST | `/api/v1/marketing/followups/:id/reminders/:channel/retry` | Body `{ confirmedNotSent?: boolean }`; queues a retry for a confirmed `failed` push/email delivery, or for a `review` result only when the marketer confirms they checked the provider and found no delivery. The channel must remain enabled and available. Limited by the follow-up action rate limiter. Requires migration 090. |
| POST | `/api/v1/marketing/followups/:id/complete` | Completes an open task. |
| POST | `/api/v1/marketing/followups/:id/cancel` | Cancels an open task. |
| POST | `/api/v1/marketing/followups/:id/todoist` | Copies an open follow-up to Todoist with contact/campaign context and due datetime; reuses a mapped or marker-matched active/recently completed task to avoid duplicates. |
| POST | `/api/v1/marketing/followups/:id/todoist-sync` | Body `{ confirmed: true }`; checks the linked task, or recovers a prior copy by its stable marker. If Todoist shows it completed, the matching open Interlink follow-up is completed. Active tasks stay open. Todoist completion history is limited to the last 89 days; a missing task is reported without completing the Interlink task or creating a replacement. Limited to 30 manual checks per user per hour. Requires migration 074 and a connected Todoist account. |

### `/api/v1/marketing/content` (Marketing content calendar)

All routes require authentication. Calendar records and approval events are Interlink-owned. `planned` without a provider and destination is internal planning; an explicitly confirmed direct social schedule stores its selected destination and queues the approved post through QStash.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/marketing/content?from=&to=` | Lists the user's content items, optionally filtered by ISO datetime range. |
| POST | `/api/v1/marketing/campaigns/:id/repurpose` | Creates draft content for planned non-email channels, grounded in the campaign copy; safe source-based templates are used if AI drafting is unavailable. Existing active content for the same campaign/channel is not duplicated. |
| POST | `/api/v1/marketing/content` | Creates a draft with title, channel, copy, optional campaign, asset URL, and planned time. |
| PATCH | `/api/v1/marketing/content/:id` | Edits content or its planned time. A substantive edit to an in-review, approved, or planned item resets it to draft and clears its old plan so the changed version must be reviewed again. |
| POST | `/api/v1/marketing/content/:id/submit` | Moves a draft into review and records the event. |
| POST | `/api/v1/marketing/content/:id/approve` | Records marketer approval. |
| POST | `/api/v1/marketing/content/:id/plan` | Body `{ scheduledAt }`; requires a future time and plans internally after approval. |
| POST | `/api/v1/marketing/content/:id/schedule-publish` | Body `{ confirmed: true, provider, targetId, scheduledAt }`; requires approved matching Facebook, Instagram, or LinkedIn content, an active provider connection, a live destination, and a time at least 15 minutes ahead. Saves a durable user-scoped schedule and sends through a signed QStash worker. The hourly marketing dispatcher retries queue submission, and only the next six days are sent to QStash so the free-tier delay limit is respected. Cancelling, rescheduling, editing, or manually publishing invalidates the old schedule generation. An uncertain provider result locks the item for human review. Requires migrations 072 and 092 plus the hourly QStash Schedule. |
| POST | `/api/v1/marketing/content/:id/unschedule-publish` | Body `{ confirmed: true }`; removes a pending/queued automatic publish while retaining the approved draft. A worker already publishing or a schedule in provider review cannot be removed without checking its outcome. Requires migration 092. |
| GET | `/api/v1/marketing/content/publish-targets?provider=facebook\|instagram\|linkedin` | Lists current Facebook Pages, the connected Instagram professional account, or the connected LinkedIn member profile available to the user's active Composio connection. |
| GET | `/api/v1/marketing/content/provider-checks` | Returns the latest user-scoped provider read-back snapshot for each published post with saved provider and destination IDs. Requires migration 081. |
| GET | `/api/v1/marketing/content/post-monitoring` | Returns the user's opt-in daily social post monitoring setting and last run summary. Requires migration 083. |
| PUT | `/api/v1/marketing/content/post-monitoring` | Body `{ enabled, providers: ["facebook"|"instagram"|"linkedin"] }`; saves selected providers after confirming those Composio accounts are active. The existing daily analytics dispatcher queues a per-user read-only check job; each user is limited to ten due posts per daily run. Failures do not change local publication state. Requires migration 083 and the signed daily QStash Schedule. |
| POST | `/api/v1/marketing/content/:id/provider-check` | Performs a read-only Facebook, Instagram, or LinkedIn check using the post and destination IDs saved by a confirmed Interlink publish. Stores only normalized state, public permalink, publication time, and available counts; a failed provider read does not change local publication state. Limited to 20 checks per user per hour. Requires migration 081 and a still-connected account with provider read permissions. |
| GET | `/api/v1/marketing/content/:id/provider-checks` | Returns the 40 most recent provider check snapshots for an owned content item. |
| POST | `/api/v1/marketing/content/:id/publish` | Body `{ confirmed: true, provider, targetId }`; immediately publishes an approved/planned matching Facebook Page text/link, JPEG/PNG photo, or MP4 video post; Instagram Business/Creator JPEG/MP4 post; or LinkedIn member-profile text/link post. The provider must be connected with its current publishing permissions. Limited to 6 attempts per user per hour. Returns the published item only after a provider post ID is received and saved. A timeout or missing ID moves it to `publishing`/`publish_review`; do not retry until the provider has been checked. Requires migration 072 and appropriate provider account scopes. |
| POST | `/api/v1/marketing/content/:id/publish-retry` | Body `{ confirmedNoPost: true }`; returns an unresolved publishing item to its previous approved/planned state only after the user confirms they checked the provider and no post exists. |
| POST | `/api/v1/marketing/content/:id/published` | Records that the user verified publication, with provider and optional provider item ID. Supports resolving an uncertain direct publish after the user checks the provider. |
| POST | `/api/v1/marketing/content/:id/completed` | Records completion of an event or other marketing activity; it does not execute the activity. |
| POST | `/api/v1/marketing/content/:id/cancel` | Cancels a content item and invalidates any waiting automatic publish schedule. |
| GET | `/api/v1/marketing/content/:id/history` | Reads atomic lifecycle events and saved content revisions. |

### `/api/v1/notifications` (Notification Hub)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/notifications` | Feed for the active mode (`X-Interlink-Mode`). `?includeCalendar=true` for the full screen; the Events widget omits it so calendar items do not duplicate the event list below. `?limit=` (max 100). Returns `{ items, mode, summary, summaryIsFallback }` — `summary` is the once-daily narration, `summaryIsFallback` true when the deterministic sentence was used. |
| GET | `/api/v1/notifications/unread-count` | Both modes at once — the bell dots one, the mode toggle signals the other. |
| GET | `/api/v1/notifications/health` | Per-source status for the in-widget staleness warning. |
| POST | `/api/v1/notifications/:id/resolve` | User handled it here. |
| POST | `/api/v1/notifications/:id/dismiss` | User does not want it. Never resurrected by a later poll. |
| POST | `/api/v1/notifications/:id/opened-external` | User tapped through to the source app. Load-bearing: it is the denominator of the success metric (inline actions vs deep-links out). |
| POST | `/api/v1/notifications/:id/draft-reply` | Gmail items only. Proposes an AI reply; sends and mutates nothing. Returns `{ to, toName, subject, body, isFallback, originalSnippet }`. |
| POST | `/api/v1/notifications/:id/send-reply` | Body `{ body }` — the exact text the user approved. Sends via Gmail from the thread's own account and resolves the item. Never regenerates the text server-side. |

```bash
curl -s "$API/api/v1/notifications?includeCalendar=true"   -H "Authorization: Bearer $TOKEN" -H "X-Interlink-Mode: professional" | jq
```

### `/api/v1/workers` (internal — QStash callbacks, `Upstash-Signature` verified)
`POST /calendar-sync`, `/triggers`, `/workflow`, `/conflicts`, `/notifications`, `/email`, `/dlq`, `/marketing-todoist-dispatch`, `/marketing-todoist-sync`, `/marketing-followup-reminder`, `/marketing-hubspot-monitor`, and `/marketing-social-publish`.
The marketing dispatcher is intended for an hourly QStash Schedule; it queues one Todoist, reminder, and HubSpot monitoring job per eligible user (up to 50 users per tick), and dispatches due-window social publish schedules. Each reminder job handles at most ten due follow-ups, adds in-app items to the Notification Hub, and sends push/email only when explicitly enabled by the marketer. Delivery attempts are independently claimed and record `pending`, `sending`, `sent`, `failed`, or `review`; confirmed failures can be retried directly, while uncertain sends require checking the provider and explicit confirmation before retry. Claims still in `sending` for more than 15 minutes move to `review` on the next dispatcher tick. Email goes to the marketer's connected Google mailbox, never to the contact. HubSpot checks examine up to ten deals per user per hourly run and only queue changed field names for human review. Todoist jobs read each user's active tasks once and (when needed) the last 89 days of completion history, complete only mapped Interlink follow-ups found there, and leave missing/older tasks open. Social schedules remain durable in Postgres; queued jobs include a schedule generation, and workers atomically claim once before a provider write. Register the hourly Schedule against `/api/v1/workers/marketing-todoist-dispatch` in the target QStash workspace; the repository change does not create that external Schedule. Per-user messages use `enqueueJob()` and normal QStash signature/retry handling.

The social scheduler holds distant schedules in Postgres and sends them to QStash only inside a six-day delivery window. This stays below the [QStash free-tier maximum delay of seven days](https://upstash.com/docs/qstash/features/delay); the target deployment still needs the hourly dispatcher Schedule registered.

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

### Marketing QStash schedules

After deploying the backend and applying migrations `064`–`092`, set `API_BASE_URL` to the public backend origin and `QSTASH_TOKEN` in the backend environment. Run `npm run marketing:schedules` to preview the hourly and daily destinations; run `npm run marketing:schedules -- --apply` to create or update the stable per-host schedules. The hourly route reconciles Todoist tasks and follow-up reminders, checks opted-in HubSpot deals, and dispatches confirmed social posts. The daily route refreshes opted-in analytics and social post metrics. Both worker endpoints verify QStash signatures using the configured current and next signing keys.
### `/api/v1/todoist`

Uses Todoist API v1 with cursor pagination and rotating OAuth refresh-token support. `GET /api/v1/todoist/projects` lists the connected user's projects. Marketing follow-up copies include a stable Interlink marker so repeat requests reuse the existing active Todoist task. `GET /api/v1/marketing/todoist-project` and `PUT /api/v1/marketing/todoist-project` read or save the account-validated default project for new follow-up copies; send `{ projectId: null }` to use Todoist Inbox. Existing linked tasks stay in their current project. Requires migration 082.
