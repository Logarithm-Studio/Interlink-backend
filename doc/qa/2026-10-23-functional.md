# Functional emulator QA - 23 October 2026

Status: available checks completed; full native/provider sign-off blocked. This report distinguishes native UI actions, requests made
through the emulator's authenticated app client, automated service tests, and
provider-verified results. Prior visual smoke checks do not count as functional
passes in this run.

## Coverage ledger

| Area | Required checks | Current result |
| --- | --- | --- |
| Baseline | App TypeScript/lint, backend build, registered tests | Pass: app TypeScript; lint zero errors/70 existing warnings; backend build; 111 tests pass, one opt-in database test skipped |
| Personal | Events, attendance, reminders, mail, assistant, templates, notifications, accounts | Template CRUD/persistence passed through emulator client; notification feed/count/source-health reads passed. Native workspace/provider-dependent actions blocked by Google reauthorization |
| Professional | Six role dashboards, forms, workflows, automations, navigation | Six dashboard APIs return the selected role and role-specific sections; finance data APIs and automation reads pass. Native forms/actions/navigation not cleared in this run |
| Campaigns | Brief creation/editing, goals, review, research, repurposing, audit | Create/persistence, supported subject/goal edits, audit and invalid-input rejection pass through emulator client. Fresh research/repurposing and Mailchimp execution not run |
| Content | Draft/edit, review/approve, approval invalidation, plan/cancel, failure/retry | App-client create/review/approve/plan/edit-invalidation/history/cancel pass; unconfirmed publication rejected. No fresh native retry or provider publication pass |
| Leads | Hosted form, attribution, dedupe, consent, qualification, conversion | Read and QA contact creation pass; fresh full intake/conversion workflow not run. Prior October 16 evidence is not counted as a new pass |
| Follow-ups | Create/reschedule/complete/cancel, reminder state, Todoist handoff | Create/reschedule/complete/persistence and preference read pass; Todoist requires reconnection. Cancellation/reminder execution not freshly cleared |
| Activations | Events/creator records, costs, outcomes, links and CRM relationships | Event create, BDT costs/manual outcomes, history and cancel pass. Creator/tracking/CRM attribution are not fully retested |
| Facebook | OAuth consent, active connection, Page selection, QA publishing, read-back | App-client connect initiation and secure consent redirect pass. User has no test accounts; consent, destinations, publication and read-back blocked |
| Instagram | OAuth consent, account selection, eligible media, publish/read-back | App-client connect initiation and secure consent redirect pass; current media action schemas match. Actual connected-account media publication/read-back blocked |
| Other providers | LinkedIn, Mailchimp, Todoist, Notion, HubSpot, analytics | LinkedIn/Mailchimp/analytics disconnected; HubSpot failed; Todoist needs reconnection. No connected execution pass |
| Resilience | Offline/error, retry/double submission, background/relaunch, text scaling | Validation rejection checked. Startup input-dispatch ANRs, emulator interruptions and a System UI ANR prevent native stability sign-off; no fresh large-text/retry clearance |

## Current findings

- The existing saved Google connection requires reauthorization. The native app
  redirects to Connect Google, so authenticated API checks are recorded separately
  from workspace UI checks. User sign-in is pending; credentials are never requested
  in chat. A cached-bundle restart recovered from startup input-dispatch ANRs;
  this is not a release-build ANR clearance.
- Facebook and Instagram were disconnected. Connection initiation from the actual
  emulator app client succeeds for both and returns HTTPS Composio consent links.
  Consent is not completed and no active account or successful publication is claimed.
- Seven current Meta tool schemas were fetched from the provider catalog, including
  Page listing, Facebook text/photo/video publishing, Instagram account lookup,
  media creation and publication. This verifies request contracts, not provider permission.
- Internal content review/approval/planning, edit invalidation, revisions and
  cancellation pass. Activation create/outcome/history/cancel and follow-up
  create/reschedule/complete/persistence pass through the emulator client.
- One harness assertion requested an unsupported campaign `offer` PATCH. The
  supported subject/goal edit was retested successfully. This was a test error;
  `offer` remains a creation-time field under the current API contract.
- Invalid campaign dates and goals correctly return HTTP 400, but the backend's
  generic response says `topic is required.` even when the topic is present.
  Fixed locally: the route now uses the extracted brief parser and returns the
  actual field/date/range/goal reason. Two regression cases failed against the old
  behavior, then all three tests passed after the fix. Registered them in `npm test`.
  This report was recorded before the fix was pushed. The GitHub push may trigger deployment; production rollout is not verified by this report.

## Evidence and cleanup

- Read-only app-client ledger: 35 calls, 33 successful responses and two genuine
  provider connection gates (Mailchimp audiences and Todoist projects). An unused
  Tasks API module was absent from the Metro graph; its actions were not executed.
- Internal lifecycle ledger: 26 passing assertions plus one invalid harness
  assertion about unsupported `offer` editing. The supported goal/subject PATCH
  was retested successfully and is recorded separately; no duplicate rerun fixtures.
- Native navigation reached the Google connection gate. This run does not repeat
  the earlier report's 33-route visual clearance or claim every feature works.
- User confirmed that no social test accounts are available and Google cannot be
  reconnected now. They approved publishing/removing clearly labeled QA posts on
  future test accounts; that approval has not been exercised.
- The original Sales profession was restored and the temporary QA email template
  removed and verified. Emulator interruption prevented client cleanup, so a
  transaction restored only the recorded QA user's role and removed only the
  exact non-default QA template, with identity guards and verification.
- The QA campaign and contact remain clearly labeled `QA 20261023`; the current
  app has no deletion controls for those records. QA content and activation are
  cancelled; the follow-up is completed. No sends, public posts, paid actions,
  schedules or provider-alert subscriptions were enabled.
- Emulator restarts preserved installed app data and authentication. A separate
  project's emulator was observed and left untouched. Very low free host memory
  and Android System UI ANRs limit interpretation of startup performance; the
  precise cause of each emulator interruption is not established.
- Stopped the unresponsive InterlinkQA emulator and this run's Metro server at
  the end. Its AVD data remains intact; no saved accounts or other AVDs were removed.

Private ledgers: `read-functional.json`, `internal-lifecycle.json`,
`roles-templates.json`, `provider-schemas.json`, `meta-connect-results.json`.
Consent URLs are saved only in the private scratch directory.

Catalog verification references: [Composio tool schema endpoint](https://docs.composio.dev/reference/api-reference/tools/getToolsByToolSlug)
and [authentication flow documentation](https://docs.composio.dev/docs/authentication).

Private account captures, fixture IDs and harnesses belong under
`.scratch/qa-2026-10-23/`; do not publish tokens, consent URLs or account screenshots.
No existing user data will be deleted to make tests pass. Clearly named QA records
are tracked separately; sends, publication and provider writes require agreed test assets.
