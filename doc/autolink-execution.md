# Autolink execution and saved work

Autolink proposes a write, the user reviews it, and the execute endpoint runs the
existing owned service. A proposal is not a completed action. The app now passes
the current conversation ID to execution so the next turn receives the actual
result, including an unsuccessful or unconfirmed outcome. Another user's
conversation is rejected before the service can make a change. A history-write
outage does not change a completed external operation into a retryable failure.

Marketing exposes `read_marketing_campaigns` as an automatic read tool. It returns
at most 20 owned records with exact IDs, status, goals and bounded copy previews;
an exact ID can retrieve a longer preview. The agent can answer a saved-draft
follow-up without creating a new record. Campaign draft actions preserve supplied
objectives, success criteria and channels, and their execution results include
the saved ID and status. They never send email.

The action-intent fallback now applies only to an explicit imperative. Mentioning
"campaign", "page" or "invoice" in a question, or saying "do not create", must
not force an unrelated write tool. Normal model-selected reads and multi-step
discovery continue through the existing agent loop.

Validation: registered intent tests, sandbox ownership/history/record lookup
scenarios, and a real-model service replay. Before the correction, asking for the
ID and status after saving a local campaign proposed `log_activity`. After the
correction it returned the exact ID/status verified through a separate database
query, with no action proposed. Live replay was service-level, not simulated
model output. Native/emulator acceptance is recorded separately in the QA report.

## Campaign copy generation

Professional email drafts reserve enough output for complete structured JSON,
including a bounded thinking budget. An unavailable model does not insert the
generic follow-up fallback into a marketing campaign: the saved draft keeps its
topic and an empty body for the marketer to complete. Autolink explicitly reports
that copy was unavailable. Saved draft IDs and statuses remain queryable.

## Professional tasks and approvals (migration 097)

The Professional command route accepts up to 12,000 characters. A proposed action
creates an owned `autolink_tasks` record containing the original goal and an
`autolink_action_proposals` record containing the exact name, arguments, summary,
timezone and applicable attachment digest. The response includes `task` alongside
the existing `action`, `answer` and `conversationId` fields. Analytical and drafting
answers can remain ordinary chat replies without forcing a tool call.

The app confirms model proposals through the task action endpoint, which reads
the saved payload rather than trusting replacement arguments from the client.
An atomic database claim permits one execution. Concurrent confirmation, lost
responses and application restarts cannot execute that proposal twice. Successful
replays return the recorded receipt. Pending approvals expire after 30 minutes;
expired steps require a new request. Pausing prevents delayed confirmation.

After success the app asks the planner to continue the original goal using actual
execution receipts and fresh owned-service context. Each later write receives a
separate review. A failed or unconfirmed outcome blocks continuation. Identical
successful actions in the same task cannot be proposed again. Tasks allow at most
12 write steps; they are interactive workflows, not unattended background agents.
An abandoned planning lease can be released after two minutes. A running provider
operation remains locked if its outcome was not recorded; check the destination
before starting replacement work. Existing deterministic form execution remains
on `/assistant/execute`, with each service's existing approval/uncertainty rules.

Original attachment bytes remain in client memory during a task and are supplied
again for continuation. The server checks their digest. After process loss the user
must reattach the original file when the remaining work needs it; completed steps
remain saved. Raw attachments are not stored in the task tables. Upload proposals
also bind the reviewed file digest, preventing silent file substitution.

The Gemini client preserves all function calls and thought signatures. The shared
loop feeds every discovery result back as structured data, validates declared tool
names and required argument types, detects repeated lookups, and bounds discovery
to eight rounds (maximum twelve) and a 40-second planning deadline. Routine tool
choreography uses the configured fast Gemini model with a bounded thinking budget.
Tool output and attachments are treated as untrusted data in the professional
execution prompt. Server-side ownership, consent and service validation remain
the enforcement boundary; prompt rules alone are not a security guarantee.

Native GitHub and Jira tools now discover assignable users and separately assign
existing issues after review. GitHub checks assignability and returned assignees;
Jira performs an assignment read-back. A created ticket is not proof that a person
accepted or completed it. Provider failures and uncertain writes remain failures.

## Connection retention

Provider-token decryption/configuration errors return 503 without erasing saved
ciphertext or marking user revocation. Google refresh calls coalesce per account
and persist a returned rotated refresh token. Explicit invalid-grant/revocation
signals require reconnection; a generic 401/403 does not erase the credential.
Composio retry cleanup deletes abandoned attempts while retaining ACTIVE accounts.
Client cache clearing preserves auth keys and preferences, and native Supabase
refresh follows AppState foreground/background transitions.

These changes cannot restore credentials already erased before deployment or
prevent genuine provider revocation/expiry. Preserve encryption keys across
deployments and update Android installations with matching signing identity and
`adb install -r`. Never use uninstall or app-data clearing as an update procedure.

Marketing adds `read_marketing_destinations` and
`export_marketing_research_plan` to the existing owned-workspace tools. The server
resolves destination and contact labels, then binds review to the current plan
fingerprint. Execution uses the same durable research-export service as the form;
Notion and Todoist each require their own confirmation. Existing copies retain
their receipts; uncertain writes require reconciliation in Research & planning.
The model cannot supply review labels or replace the saved action payload.
For explicit research-plan export requests, planning keeps the native research
write tools and read tools; unrelated writes are excluded from that task's tool
surface. Start a separate request for unrelated changes. This prevents generic
task/page creation from bypassing export receipts. Resolved actions emit the
review card rather than asking for a yes in prose. A real Gemini check exposed
both problems before this correction and passed both provider steps afterward.

Verification evidence lives in the app's `docs/qa/` reports. The November 7 Vercel
configuration repair restored signed QStash callbacks: both dispatchers returned
200, a real Todoist completion reconciled successfully twice, and unsigned or
invalid signatures still returned 401. Only the two Marketing schedules were
resumed after these checks. Simulated-provider tests remain separate from live
delivery/signature/publication acceptance.

Provider contracts: [GitHub assignees](https://docs.github.com/en/rest/issues/assignees),
[Jira assignment](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-assignee-put),
[native Supabase lifecycle](https://supabase.com/docs/guides/auth/quickstarts/react-native).
