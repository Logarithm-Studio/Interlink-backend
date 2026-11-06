# Autolink execution and recovery

Professional Autolink uses the shared Gemini planner and existing deterministic
services. Its 65 shared native declarations have executor bindings; the attachment
email declaration is deliberately materialized into the reviewed bulk-mail action
by the spreadsheet planner. Connected Composio tools add a bounded, account-scoped
surface. This inventory establishes bindings, not live acceptance of every provider.

Marketing also exposes owned contacts, research plans, sequence status and agreement
status through `read_marketing_workspace`. `create_marketing_research_plan` saves a
reviewed shortlist through the existing Research & planning service. It uses exact
owned contact IDs and the durable task confirmation/receipt path; replay cannot
create another plan. This action does not export, schedule outreach or send a
signature request. Provider handoffs retain their separate destination/content
review in the Marketing workspace.
Proposal contact labels are resolved from owned records on the server; model text
cannot replace the reviewed names or addresses. Foreign contacts are rejected
before the proposal is shown, and ownership is checked again when saving.

Commands in both modes accept trimmed text up to 12,000 characters. Empty messages,
invalid task IDs and invalid schema values return 400 with validation details.
The shared planner limits discoveries and time, validates declared tool names and
arguments, preserves parallel function-call responses and signatures, and returns
one proposed write at a time. Exports and composite connector actions such as
GET_OR_CREATE require review; a read-like prefix alone cannot authorize a mutation.

Professional tasks persist the original goal, exact proposed arguments, source-file
digests and actual receipts. The authenticated execute route loads those arguments
from storage. Its atomic claim prevents repeated execution. Unknown outcomes remain
blocked for provider inspection; losing receipt persistence keeps the action locked.
Provider requests never run while a database transaction is open.

Pending reviews expire after 30 minutes. Reading an expired proposal marks it
cancelled with an explicit no-execution receipt and releases the task for a fresh
plan. Expired reviews do not consume the 12-action execution limit. Paused tasks can
resume even when their old review expired. Completed steps and source-file binding
remain available for continuation.

Conversation deletion and action/continuation claims serialize on the owned parent
conversation. Deletion returns 409 while planning or execution is active. The app
retains the visible conversation if deletion fails. History loading, status checks,
review/pause and confirmation cannot overwrite another active chat. Both composers
guard rapid submissions; invalid deterministic form arguments release the busy
state and show an error. Professional task receipts are the durable execution path;
legacy Personal/form execution is still a separate single-action endpoint.

The shared file preparer supports text, spreadsheets, office documents, PDF and
supported media. Invalid base64 and unsupported/unreadable binaries fail closed.
Inline files are limited to 3 MB so base64 plus JSON fits the deployed
[Vercel request limit](https://vercel.com/docs/functions/limitations#request-body-size).
Large-file storage/upload workflows are not implemented by this change. The voice
recorder serializes start/stop, releases the microphone on exit, restores playback
mode, checks file size and ignores transcription after unmount. Transcription
reserves output tokens and reports provider outages as 503.

Local caches are partitioned by the signed-in user and disabled while signed out.
An authentication-generation change discards in-flight API results and prevents a
previous user's 401 action from being retried under a new session. Cache maintenance
does not clear auth credentials. These boundaries do not replace server auth/RLS.

Registered checks include `agentLoop.test.ts`, `geminiClient.test.ts`,
`multimodal.service.test.ts`, `tool-safety.test.ts`, plus sandbox task, delegation,
recovery, attachment, connection and Marketing suites. PGlite serializes its SQL
connection; sandbox concurrency is not a production-pool load certification.
The app QA report records emulator evidence and live-provider limits separately.
