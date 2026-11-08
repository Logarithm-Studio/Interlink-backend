# Autolink execution and saved work

## Six-role hardening and initial questions (migration 098)

Migration `098_autolink_task_context.sql` must precede this backend release. It
adds private JSON metadata to the existing RLS-protected task table: the reviewed
Professional role, request clock and source-file fingerprints. It stores no raw
attachment bytes. Older tasks fall back to their saved proposal context.

An initial clarification now creates a paused task before the first write. The
same goal and source context survive answers, interrupted planning and restarts.
One unfinished task is allowed per conversation, enforced under its lock. Invalid
attachments cannot cancel an existing review. A review prepared in another role
cannot execute or consume that approval. The client recovers the matching saved
task even when the first command response was lost.

`ask_professional_question` and `complete_professional_task` explicitly distinguish
waiting for an answer from completion. For active-task continuation/correction,
plain model prose receives one bounded status-only tool turn; failure to obtain a
valid completion leaves work unfinished. Initial informational replies remain chat
replies. The paused question card says "Needs your answer"; manual pause retains
Resume. Answer in the composer to continue the same task.

`read_professional_records` discovers owned candidates, openings, tickets, property
leads/listings/leases and invoices. It supports literal search, exact IDs and
timestamp/UUID pagination, bounded to 25 results plus a continuation cursor.
Mutations resolve exact owned IDs, reject ambiguous labels and, where applicable,
recheck the reviewed stage/status atomically. Native execution also validates its
declared schema, including blank required strings, outside the model loop.

- HR requires saved resume text and a role before screening. Missing, invalid or
  unavailable model scores never become saved invented scores. `create_opening`
  saves a local opening; interview scheduling requires an email and explicit-offset
  future start/end timestamps. Outreach is an exact unsent draft.
- Support `create_ticket` saves a local ticket. Reply drafting never resolves or
  emails a ticket; triage/escalation/resolution use its exact reviewed identity.
- Real Estate `create_buyer_lead` saves a local buyer with an explicit USD budget.
  Listings remain unpublished until a separate `publish_listing` review. Listing
  copy requires its actual public URL; matching excludes incompatible currencies.
  Showings are local records, not invitations. Closing checklists require a supplied
  closing date and do not create tasks. Demo market feeds are labelled as demo.
- Product Manager PRD, interruption, release, status and scope tools prepare
  source-backed output without hidden issue creation, assignment or publication.
  Attached PRD text can be drafted without Notion/Jira. Actual requested issue,
  assignment, Notion and Slack writes each use their existing separate review.
  Failed sources are unavailable, not empty evidence; release notes use merged PRs.
- Sales Trello workflows require an exact board and reject ambiguous cards/lists.
  Pipeline digests require an exact channel. Partial failures retain actual counts.
- Finance flash reports reject mixed currencies unless one currency is selected;
  cache and email identity include the actual report content. The flash-report API
  accepts optional three-letter `currency`. Bulk reminder/tax failures cannot be
  reported as success; ambiguous client/contractor labels require an exact choice.

These are bounded interactive workflows (3 MB inline source, 12 reviewed writes),
not a claim of arbitrary-file support, unrestricted automation or universal model
accuracy. The registered sandbox matrix covers all 61 role-native tools with and
without a text attachment; separate attachment, failure and actual-model checks
are recorded in the app's November 8 Professional matrix QA report. Provider
simulation is distinct from acceptance against a connected external account.

## Professional workflow corrections (November 8)

New instructions in an unfinished Professional chat revise its owned task. The
original goal, completed receipts and added instructions remain together. Under
the conversation lock, pending approvals are cancelled before replanning; a late
tap on a replaced review cannot execute it. Running or uncertain writes cannot
be rewritten. A planner outage leaves the revised goal ready for continuation.
An abandoned revision planning lease also expires safely when only cancelled or
successful receipts remain. File-bound corrected uploads retain their digest;
continuations read the latest saved request clock and attachment context.
The client retains the original attachment and restores saved task state on error.
Use a new chat for unrelated work while a task is unfinished.

The 12-step limit applies to write proposals, permitting a final read/summary after
twelve successful writes. Continuation retains the original client clock/timezone
so a request spanning midnight does not reinterpret relative dates. Referring to
the saved invoice is distinct from explicitly referring to an attached document.

Mixed read/write model batches execute discovery first. The proposed write is
returned to the model as unexecuted and must be proposed again using the actual
results. Independent reads overlap, repeated reads coalesce, and signed model
parts and response ordering remain intact. Every write still requires review.

Sales/Marketing Autolink resolves owned contact/deal/rep labels, rejects ambiguous
names and checks a reviewed deal stage again before changing it. Discovery adds
deals and reps. Contact/deal/invoice creation returns actual IDs; currency and
minor units remain explicit, and Sales and Finance snapshots group totals by currency.
Finance client ledgers separate currencies and expose bounded unpaid invoice IDs;
individual invoices and flagged expenses retain their own currency.
Linked opportunities use the existing owned Marketing opportunity service.

Autolink's `draft_followup`, `meeting_followup` and `reengage_deal` prepare actual recipient/subject/
body without sending or changing a deal stage. Unavailable AI copy is a failure,
not fallback outreach. Sending exact copy requires a separate `send_gmail` review.
`route_lead` saves the explicitly selected owned representative as routing metadata;
it does not guess a rep, invent a meeting time or imply human acceptance.
`generate_contract` prepares a local editable agreement from supplied requirements
and signer details. DocuSign preparation/sending remains in Agreements, with its
existing separate confirmation and uncertainty guards. These are Autolink adapter
contracts; legacy standalone Sales REST/automation helpers retain their own paths.

Finance reminder planning/execution rejects ambiguous client-name matches rather
than selecting the first unpaid invoice. Exact owned invoice IDs remain supported.
Currency-aware invoice creation retains the confirmed amount, currency and saved ID.

Plain English requests starting with draft/outline/brainstorm/write use read tools
only unless they also request a persistent action (for example saving to Notion).
Negative instructions such as "do not send" do not enable write tools. Drafts stay
in chat; connecting a notes app is not itself a request to save a page. This scope
selection improves common drafting requests; ownership/review remain mandatory
for all writes and natural-language intent is not a universal success guarantee.

The earlier corrections did not change Personal task architecture, providers,
dependencies or schema. The shared agent-loop/review fixes also apply wherever
those shared components are used.

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

An unavailable or failed planner returns HTTP 503. During continuation the task
returns to `ready`, preserving its successful receipts and the Continue control.
A model outage is never saved as an answered task. Retrying continuation plans
from the existing receipts; it does not execute a previous proposal again.
Owned snapshots, connection discovery, history and tool discovery load concurrently
before planning. This removes serial prerequisite waits without changing approvals.

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
For explicit research-plan export requests, competing Notion/Todoist write tools
stay unavailable until that provider has a successful native export receipt in
the same task. Unrelated tools remain available, so a mixed export/Calendar goal
can continue through separate reviews. A completed export releases that provider's
generic tools for separately requested work. Continuation scopes tools from the
original goal and saved receipt statuses, excluding receipt text from routing.
Resolved actions emit the
review card rather than asking for a yes in prose. A real Gemini check exposed
both problems before this correction and passed both provider steps afterward.

`read_marketing_workspace` supports `query`, `recordId` and `cursor` for contacts
and research plans. Search runs before the 25-contact/20-plan limit across owned
records, rather than searching a previously truncated list. `hasMore` and
`nextCursor` permit bounded continuation; timestamp/UUID ordering retains full
PostgreSQL timestamp precision. Search treats percent/underscore as literal text.
Follow-ups, content, sequences and agreements remain recent-record reads; the tool
reports this scope and rejects unsupported search/pagination arguments.

Verification evidence lives in the app's `docs/qa/` reports. The November 7 Vercel
configuration repair restored signed QStash callbacks: both dispatchers returned
200, a real Todoist completion reconciled successfully twice, and unsigned or
invalid signatures still returned 401. Only the two Marketing schedules were
resumed after these checks. Simulated-provider tests remain separate from live
delivery/signature/publication acceptance.

Provider contracts: [GitHub assignees](https://docs.github.com/en/rest/issues/assignees),
[Jira assignment](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-assignee-put),
[native Supabase lifecycle](https://supabase.com/docs/guides/auth/quickstarts/react-native).
