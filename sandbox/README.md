# Marketing integration sandbox

This tool runs the production Express routes and services against an in-memory
PostgreSQL engine (PGlite), applying all repository SQL migrations. It creates two
disposable identities. Production `.env` files are not loaded. Network access is
limited to loopback; recognized simulated provider requests return local responses
without making an external connection. Unknown provider operations fail explicitly.

Run from the backend package:

```powershell
npm run test:sandbox
```

The command installs the locked sandbox-only dependency, builds the backend, then
runs the two explicitly listed suites sequentially. It is separate from the normal
`npm test` suite; CI must invoke it explicitly to include SQL/provider scenarios.

The provider scenarios cover:

- Facebook Page text, photo and video posts; Instagram image/Reels containers;
  LinkedIn member text posts; destination discovery and post read-back.
- Pending, declined, approved, expired and revoked connection states; one-use
  simulated consent links; missing permissions and unsupported media.
- Approval/confirmation gates, concurrent submissions, uncertain writes and retry
  locks, wrong-owner read-back, history and per-user record access.
- Automatic social schedules, edits and unscheduling, stale/duplicate deliveries,
  worker execution and the real publish rate limiter.
- Mailchimp drafts, sender checklist, scheduling, sending, reports and uncertain
  send locks. Messages are only fake provider records; no mail is delivered.
- Todoist project selection, idempotent follow-up handoff and completion import;
  Notion mapped database export and duplicate prevention.
- HubSpot pipeline mappings, fingerprint-bound preview/confirmation, linked CRM
  creation and currency preservation.
- Selected GA4, Search Console, Meta, Google Ads and Stripe analytics snapshots,
  partial failure, exact simulated counts and landing-page privacy.

To keep an instance running for emulator work after building:

```powershell
npm --prefix sandbox start
```

It binds only to `127.0.0.1:4317`. Disposable login/control values are written to
ignored `sandbox/.session-private.json`. The frontend must be an isolated app copy
configured with that local API/Supabase URL and a dummy anon key. Use a dedicated
AVD; do not replace a normal user's backend/session configuration. ADB reverse
forwards the sandbox and its separate Metro port to that AVD.

Cleanup uses the operator-key-protected `POST /__sandbox/control/cleanup`, or Ctrl+C
in the sandbox server terminal. Cleanup revokes the in-memory identities, clears
fake provider effects, closes/destroys the database and removes the session file.
The automated suites verify empty identity/provider stores and inaccessible closed
database state. Temporary AVDs and client copies are separate artifacts and must
also be removed after native QA.

The Composio adapter boundary and provider HTTP responses are simulated. Native
Todoist/Notion services, marketing SQL and workflow services run unchanged. Auth's
external GoTrue endpoint is simulated; the production login route, bearer-token
middleware and app Supabase client can still execute their normal paths. Real
OAuth grants, provider API compatibility, media processing, billing, email delivery,
QStash signatures/delivery timing and production PostgreSQL pool concurrency are
not certified by this sandbox. Scheduling tests capture queue envelopes and invoke
the actual worker with due fixture timestamps. No external provider test account
is created, and no real post, message, payment or advertisement is produced.
SQL runs as the disposable database owner; this is not a database-role/RLS audit.
