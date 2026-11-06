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
