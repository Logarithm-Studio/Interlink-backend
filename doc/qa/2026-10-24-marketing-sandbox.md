# Marketing sandbox QA — 2026-10-24

## Reproducible integration checks

Run `npm run test:sandbox` from `Interlink-backend`. The locked tooling package
installs PGlite 0.5.11, builds the production backend and explicitly runs both
sandbox suites. All 95 migrations execute unchanged against disposable PostgreSQL.
Two disposable identities exercise the real login route and bearer middleware.
External authentication, consent, provider responses and queue transport are
simulated at their boundaries. Production environment files are not loaded.

The final expanded run passed **44 tests, zero failures, zero skips**. The regular
backend suite passed **112 tests, zero failures, one existing skip** (113 total).
The backend TypeScript build passed as part of the sandbox command.

| Integration | Verified against simulated provider |
| --- | --- |
| Facebook Pages | Consent approve/decline/replay, targets, text/photo/video publishing, post IDs, read-back metrics |
| Instagram | Consent, target discovery, image container/publish, MP4 Reels, owner validation and read-back |
| LinkedIn | Consent, member target, text publishing, post ID and owner validation |
| Mailchimp | Audiences, draft/content, checklist rejection, schedule/unschedule, send confirmation, report refresh, uncertain-send lock |
| Todoist | Encrypted connection storage, valid project selection, idempotent follow-up handoff, completion import |
| Notion | Schema discovery, mapped campaign export, duplicate-page prevention, invalid marker rejection |
| HubSpot | Pipeline/stage mapping, preview with no writes, stale fingerprint rejection, confirmed linked contact/deal creation, BDT currency |
| Analytics | Selected GA4/Search Console/Meta/Google Ads/Stripe snapshots, exact fixture values, partial failures and URL privacy |

Cross-cutting checks include approval and explicit confirmation, concurrent duplicate
publish requests, ambiguous writes, expired/denied connections, invalid media,
per-user history, scheduled-worker execution, edit invalidation, unscheduling,
duplicate/stale queue deliveries and the actual publish rate limiter. An external
fetch is deliberately rejected by the sandbox network guard.

## Production defects found and corrected locally

1. Social scheduling inferred a bare timestamp parameter as an interval in two
   six-day due-window queries. Real PostgreSQL rejected the comparison with SQLSTATE
   42883. Explicit `::timestamptz` casts fix both queries. Scheduling scenarios
   reproduced the failure before the fix and passed afterward.
2. GA4 landing-page normalization retained unexpected query strings and fragments.
   These can contain private values. Normalization now strips them before storing
   snapshots. An existing registered unit-test file gained a red/green regression;
   the sandbox also asserts the private fixture query is absent.

Some initial failures were harness mistakes: connect response shape, expected
HTTP status, nested response fields and Mailchimp's conservative pending-send
state. Those were corrected in the harness rather than changing production
behavior to satisfy mocks.

## Boundaries

These results verify application behavior against controlled provider responses.
They do not certify real OAuth app approval/scopes, provider API compatibility,
public media retrieval/processing, actual mail delivery, ad spend, payments,
QStash signature/timing behavior or production connection-pool concurrency.
Google Ads and Stripe coverage is read-only analytics, not ad creation or charging.
The Composio SDK connection-persistence boundary is replaced; native Notion and
Todoist HTTP service code executes normally against intercepted responses.
SQL runs as the disposable database owner; role/RLS enforcement is outside this
suite's sign-off.

Automated teardown clears identities, connections, fake posts/messages/CRM records,
pages/tasks and queue records, then closes the in-memory database. Tests assert
empty stores and inaccessible closed database state. No real provider account,
post, email, advertisement, charge or production database row is created.

## Android emulator walkthrough

A dedicated `InterlinkSandboxQA` API 34 x86_64 AVD ran a native debug client.
The client source was copied from app commit `3d1cf85`, with loopback-only fake
API/Supabase configuration in the copy. The original app configuration was not
edited. An x86_64 debug build succeeded; the pre-existing ARM-only debug APK was
backed up and restored afterward, with its SHA-256 checked.

Passed through native controls:

- Disposable email/password login and switching from Personal to Work mode.
- Facebook and Instagram Connect buttons opened local simulated consent pages.
  Consent was submitted through browser DOM automation; closing the browser tab
  exercised the app's cancellation/return polling and showed both connections.
- For each provider: create a draft in the form, submit for review, approve,
  review its actual destination, confirm the native publish dialog, then refresh
  provider status. Saved post IDs and read-back snapshots were checked through
  the real API independently of the visible success message.
- Facebook post `1234567890_100001`: likes 7, reach 23, views 31, shares 1,
  comments 2. Instagram image post `1000100003`: likes 9, comments 3.

Evidence: [connected accounts](2026-10-24-sandbox/social-connected.png),
[Facebook publication/read-back](2026-10-24-sandbox/published-facebook.png),
[Instagram publication/read-back](2026-10-24-sandbox/published-instagram.png).

Native limitations: Android showed System UI/app ANRs during initial loading.
Chrome logged failed GPU context creation and displayed a blank consent page
although its DOM and local server response were valid. Browser DOM automation
was used for consent; automatic browser-to-app OAuth redirect was not signed off.
A long idle interval expired the driver's original token; the driver renewed its
login and the app required a fresh disposable login before the Instagram retest.
Long-idle production session refresh is not certified by this simplified auth
simulator. Other providers have API/workflow coverage above, not a complete
native screen walkthrough in this run.

## Cleanup

The native sandbox operator endpoint cleared both identities, all three fake
social records (including Instagram's container), connections and the database;
the private session manifest was removed. No unexpected external network
request was recorded during the native run. Metro was stopped, the dedicated
AVD was stopped and deleted using Android's named-AVD command, and the original
debug APK was restored. The normal InterlinkQA AVD was not changed.

Automatic approval review rejected removal of remaining temporary source/build
copies under `.scratch/sandbox-qa-2026-10-24` with the generic reason "blocked by
policy". Those inert copies remain; their local `.env` contains dummy values
only. There are no live test identities, provider records or emulator data left.
