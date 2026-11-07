# Marketing outreach workflows

Use this document when changing email sequences, signature envelopes, research
shortlist exports, their jobs, or their deployment. The workflow routes are mounted
after Marketing bearer authentication. Every resource lookup includes `user_id`.

## Deployment

Run `npm run marketing:readiness` to inspect local configuration without network
requests. Add `-- --online` for read-only migration/table-protection metadata,
QStash schedule listings and public API health checks. It exits nonzero when a
requirement is missing and never prints credential values. Existing environment
variables override `.env`; `MARKETING_APP_API_BASE_URL` can identify the app's
target when checking a staging deployment instead of the adjacent app `.env`.
Run it in the intended deployment environment: local settings do not establish
which variables are configured remotely. A successful health check alone does not
prove that this uncommitted release is deployed or that worker signatures work.

1. Apply migrations through `096_marketing_outreach_workflows.sql` to staging
   before deploying this backend version. It adds sequences, agreements, research
   plans and export records. These tables use RLS with direct access revoked from
   `anon` and `authenticated`; the authenticated Express services own access.
2. Deploy the app and API together. Keep existing Supabase, native Google/Notion/
   Todoist OAuth and Composio configuration.
3. Configure DocuSign custom OAuth using `DOCUSIGN_CLIENT_ID`,
   `DOCUSIGN_CLIENT_SECRET` and `DOCUSIGN_AUTH_URL`. The default authorization host
   is the DocuSign demo host. Use the matching production host and app credentials
   for production. Allow the callback URI required by the Composio auth config.
4. Ensure the existing signed hourly `/api/v1/workers/marketing-todoist-dispatch`
   Schedule is enabled. It now also dispatches sequence deliveries and signature
   checks. New queues are `marketing-email-sequence` and
   `marketing-agreement-check`; each provider operation runs in its own signed,
   user-scoped job. Configure both QStash signing keys and its token as usual.
   In Vercel production, callbacks use `VERCEL_PROJECT_PRODUCTION_URL`; previews
   use their own `VERCEL_URL`. Local/self-hosted runs retain `API_BASE_URL`.
   `/health` reports the resolved `workerOrigin` so a rollout can verify routing
   without queueing a real provider action. See [Vercel system variables](https://vercel.com/docs/environment-variables/system-environment-variables).
5. Run the registered unit and sandbox suites, then the controlled account tests
   in the root QA report. A sandbox pass does not verify provider OAuth approval,
   document conversion, mail delivery or QStash transport/timing.

## Email sequences

Worker verification uses the original JSON bytes and the resolved callback URL.
Vercel body parsing is disabled at the function entry point so Express can capture
those bytes. Unsigned, altered, expired or wrong-destination callbacks return 401.
Missing verification configuration or missing raw bytes returns 503 and never runs
the processor. A signed malformed `{}` envelope must reach 422 on the sequence and
agreement-check routes before background delivery can be accepted. Keep schedules
paused while that transport check fails; do not disable signature verification.

`POST /api/v1/marketing/email-sequences` accepts an owned `contactId`, a confirmed
`initialMessageId`, `expectedSenderEmail`, one to three `{subject,body,delayDays}`
steps, and `confirmed:true`. Each delay is 1–30 days. The first delay starts at
approval; later delays start after the preceding confirmed send. Interlink reads
the original sent message from the resolved Work mailbox and checks its recipient.
Recorded contact consent is required for automatic mail; import alone grants none.

`GET /email-sequences` returns owned sequence state. `POST /email-sequences/:id/cancel`
cancels pending/checking/review work. A provider send already in progress cannot
be cancelled by this route. One original message can have one approved sequence.

Delivery claims `pending -> checking -> sending` atomically. Before each send it
checks current permission, prospect address, the approved mailbox, later incoming
mail from the prospect, and the original thread, including replies from aliases.
Any observed reply stops the sequence. A failed read returns to pending without
attempting mail. A successful send retains the Gmail ID and advances the step.
An uncertain send or interrupted sending claim moves to review and never retries
automatically. Cancellation, duplicate jobs and stale step numbers cannot send a
completed step twice. Reply checks and provider delivery are not one atomic
operation: a reply arriving after the last check may cross an in-flight send.

The hourly dispatcher queues only the next six days of pending work. More distant
steps remain durable until they enter that window. QStash delay handles delivery
timing; the hourly pass recovers queue submission failures. The app refreshes local
delivery state quietly while the sequence screen is focused.

## Contracts and signatures

`POST /agreements` accepts `dealId`, `requirements`, `signerName`, `signerEmail`.
It assembles an editable local document from the actual deal value and supplied
terms, without inventing clauses or sending anything. `PATCH /agreements/:id`
edits only a local draft. `GET /agreements` and `GET /agreements/:id` read owned
documents; details include a fingerprint of document and signer.

`GET /agreements/accounts` discovers the connected user's DocuSign accounts.
`POST /agreements/:id/prepare` requires an account ID, the current fingerprint and
`confirmed:true`. It reserves creation, uploads escaped HTML as an unsent envelope,
saves its provider ID/version, and includes an Interlink reconciliation marker.
`POST /agreements/:id/send` requires a separate current fingerprint and confirmation.
It rechecks the provider draft version and exact recipient list before claiming
and sending that envelope. Local edits are locked after preparation. External
edits require provider review; the app never silently adopts revised terms.

`POST /agreements/:id/refresh` reads the provider status. Hourly checks fan out to
individual jobs. Confirmed `completed` updates the linked contract to signed;
declined/voided outcomes remain distinct. Recorded deal/contract amounts are local
commercial data, not extracted proof of executed terms or recognized revenue.

An uncertain create locks in review. `POST /agreements/:id/reconcile` accepts an
existing envelope ID only when its provider custom field matches this agreement.
If the user checked DocuSign and confirmed no envelope exists, `/retry-prepare`
requires `confirmedNoEnvelope:true`, a current fingerprint and confirmation.
Unknown sending results are resolved by reading the existing envelope, not by
creating or blindly resending another one. Terminal statuses resist late reads.
Provider checks are preflight checks, not a cross-system transaction or edit lock.

The older direct-email `generate_contract` action remains a separate legacy API.
Autolink instructions and workflow links direct DocuSign requests to this reviewed
native workspace instead of treating an emailed draft as an e-signature envelope.

The legacy pipeline-cleaning `reengage_deal` action requires a contact email,
recorded marketing permission and complete AI copy. Missing/offline copy cannot
send fallback text or advance the deal. Permission and address are checked again
after drafting. This action does not replace the exact-message review and reply
checks in the native sequence workspace.

## Research shortlist exports

`POST /research-plans` saves `title`, `objective`, and 1–25 owned `contactIds`.
`GET /research-plans/:id/preview` returns the current contact fields and fingerprint.
The app displays exactly the names, companies, roles and email addresses that will
be copied. A changed snapshot rejects export before any external write.

`GET /research-plans/destinations?provider=notion&q=...` searches shared Notion pages;
`provider=todoist` lists available projects. `POST /research-plans/:id/export`
requires provider, destination ID, current fingerprint and confirmation. Notion
receives one reviewed brief; Todoist receives one research task per selected
prospect. Destinations are checked before claiming exports. These are one-way
copies; later provider edits do not sync back into the research plan.

Unique export records reserve each plan/provider/destination/item before creation.
Replays reuse those records. Partial outcomes retain per-item IDs/status rather
than claiming all copies succeeded. Uncertain creates require review. The
`/research-exports/:id/reconcile` route verifies the marker on a supplied external
ID. `/retry` additionally requires current fingerprint, confirmation and the user's
explicit `confirmedNoCopy:true` after checking the provider. A mistaken manual
no-copy confirmation can still create a duplicate; it is never an automatic retry.

## Verification

Notion exports split long paragraphs and code into rich-text fragments without
cutting their reviewed content or emoji pairs. A new page exceeding 100 blocks is
rejected before creation; it is never silently truncated to the first 100 blocks.
Append operations retain the existing 100-block batching behavior. Limits follow
[Notion's request limits](https://developers.notion.com/reference/request-limits).

`npm run test:sandbox` explicitly registers `sandbox/outreach.test.cjs` alongside
the existing suites. It executes production auth/routes/jobs and all migrations
against disposable SQL, with external services simulated at their boundaries.
Coverage includes reply/alias stopping, consent revocation, duplicate jobs,
cancellation, failed reads, uncertain writes, stale approvals, changed recipients,
reconciliation, deliberate retries, cross-user access and export replay.
PGlite serializes its database connection; this does not certify production pool
concurrency or database-role enforcement. Root `docs/qa/2026-10-25-workspace.md`
records browser evidence and the remaining live-account acceptance checks.

November 7 follow-up: independent API instances now use the follow-up UUID as a
Todoist Sync command UUID when making a planning copy. Provider idempotency
prevents the two-instance race from creating duplicate tasks; existing marker
reconciliation and the saved mapping remain in place. A barrier-based race test
reproduced the old duplicate and passes with the fix. Real Todoist parallel calls
also returned one matching task, subsequently completed for background-worker QA.

Dependency follow-up retains the earlier body-parser/gaxios/qs patches and
migrates Nodemailer to 10.3.1 and Zod to 4.6.7. Zod record schemas and generic
types were adapted to the current API. Node 20 or newer is required; Vercel uses
Node 24. Build, 135 unit tests (one existing skip), and 105 sandbox tests pass.
Production dependency audit reports five moderate advisories, zero high or
critical; this is not a clean security audit or universal provider acceptance.
