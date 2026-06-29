# Professional Agent — Accountant / Financial Analyst

Curated build spec for the first **Professional Mode** agent: the **Accountant**. Distilled from
the Gemini PRD §4.4 ("Financial Analysts & Accountants") in
[../../docs/PRODUCT-VISION-AND-STATUS.md](../../docs/PRODUCT-VISION-AND-STATUS.md) and mapped onto
the **existing** Interlink workflow engine so it can be built incrementally without a rewrite.

> Status: **Iteration 2 implemented** (2026-06-29). Live Gemini (`gemini-2.5-flash`). Now built:
> **Dunning v2** (history/relationship-aware drafts, AI escalation tone, preview→regenerate→edit→send,
> bulk "remind all overdue"), **Expense Auditing** (Gemini flags duplicates / missing receipts /
> policy / uncategorized, with approve/dismiss), **Flash Financial Reporting** (AR + cash summary +
> insights, email-to-self), a cross-cutting **AI Insights** dashboard, and a conversational
> **"Ask your AI accountant"** chat grounded in the user's data. Tax Doc Gathering & Regulatory
> Auto-Fill remain scaffolded. Data still seeded (no external OAuth).
> Trackers: [../../plan/professional-accountant-mode-iter2.md](../../plan/professional-accountant-mode-iter2.md)
> (iter2), [../../plan/professional-accountant-mode.md](../../plan/professional-accountant-mode.md) (iter1).
> History: [BUILD-LOG.md](../../BUILD-LOG.md).
>
> **Iteration 1** (2026-06-27): Dunning end-to-end (one-tap), parallel `(work)` shell, mode toggle.
>
> **Shipped in iteration 1:**
> - Gemini provider + per-mode `getProvider({ mode })` (`src/services/ai/provider.ts`); Personal stays on OpenAI.
> - `invoices` + `invoice_reminder_logs` tables (migrations 035–036); demo seed via `POST /accountant/seed-demo`.
> - `generateDunningEmail` (`ai.service.ts`) + `dunningReminder` prompt/schema/fallback.
> - `dunning.service.ts` (shared) + `accountant.routes.ts` (`/api/v1/accountant/*`).
> - `schedule.weekly` / `finance.invoice.overdue` triggers + seeded "Accountant — Dunning" workflow (037).
> - App: `ModeContext` + animated mode toggle/transition, parallel `(work)` shell (Tasks/Mails/Settings)
>   reusing `HomeTabBar` + `InterlinkWorkingModal`, invoice cards + approve/sent sheets, 5 workflow tiles.

## 0. Key decision — Gemini is the AI provider for Professional Mode

Professional Mode uses **Gemini** as the cognitive layer (per the PRD). The codebase already
anticipates this: [src/services/ai/provider.ts](../src/services/ai/provider.ts) is a vendor-agnostic
`AIProvider` interface, and adding Gemini is explicitly a 3-step change (new class + branch in
`getProvider()` + `AI_PROVIDER` env value). The Personal Mode flows continue on OpenAI.

**Implication:** provider selection must become **per-workflow / per-mode**, not a single global
singleton. Today `getProvider()` returns one process-wide instance. We need to pass a provider
hint (e.g. `mode: "personal" | "professional"`) down to the AI service so professional steps
resolve Gemini while personal steps stay on OpenAI. This is the first piece of plumbing to add.

## 1. What we reuse (already built — do not rebuild)

The accountant agent is "just another set of workflows" on the existing substrate:

- **Data-driven workflow engine** — JSON definitions in `workflows.definition`, executed step by
  step by [src/workflow/engine.ts](../src/workflow/engine.ts) with durable state in
  `workflow_executions` / `workflow_execution_steps`. Pattern reference:
  [021_seed_conflict_workflow.sql](../src/db/migrations/021_seed_conflict_workflow.sql).
- **Step registry** — [src/workflow/registry.ts](../src/workflow/registry.ts). New step types =
  new schema in `definition.ts` + handler file + `registerStep(...)`. A `GenericStep` catch-all
  already lets unknown step types be stored/loaded without parse errors.
- **Trigger → workflow fan-out** — `emitTrigger()` → `triggers` queue → matches `workflows.trigger_type`.
- **QStash job pipeline** — durable, idempotent, retry/timeout semantics, DLQ. See [CLAUDE.md](../CLAUDE.md).
- **AI service** — JSON-only, Zod-validated outputs, deterministic, idempotency-keyed, template
  fallback ([src/services/ai/ai.service.ts](../src/services/ai/ai.service.ts)).
- **Cross-cutting**: encrypted token storage / keyring, signed action tokens, audit log,
  idempotency, notifications (push + email fallback), human-in-the-loop via `notify` +
  `wait_for_input` + the workflow actions API.

## 2. What is genuinely new (build for the accountant)

| Area | Today | Needed for accountant |
|------|-------|----------------------|
| AI provider | OpenAI singleton | + **Gemini** provider, selectable per mode (§0) |
| Triggers | calendar.* only | `finance.receipt.received`, `finance.invoice.overdue`, `schedule.daily`/`schedule.weekly` (cron), `finance.threshold.crossed` |
| Connected accounts | google, microsoft | quickbooks, xero, plaid, stripe (OAuth + encrypted tokens, same `connected_accounts` table + keyring) |
| Step types | calendar/email/notify | integration steps: `quickbooks_match_txn`, `plaid_fetch_txns`, `stripe_refund`/`stripe_fetch`, `sheets_append`, `slack_message`, `drive_file`, plus a generic `http_request` escape hatch |
| Scheduled triggers | webhook-driven only | a cron/scheduler source that emits `schedule.*` triggers (QStash schedules or a DB `jobs` poller) |
| Email **ingestion** | we send Gmail; we read via proxy | a Gmail **watch/push** path that emits `finance.receipt.received` when receipts/invoices arrive |

> Principle from the original architecture (still holds): **AI generates language/structure only;
> it never decides actions. Every side effect is idempotent, retryable, auditable, and—where it
> mutates external systems—gated behind human approval** (`notify` + `wait_for_input`).

## 3. The five accountant workflows (PRD §4.4 → engine design)

Primary apps named in the PRD: **QuickBooks, Xero, Plaid, Microsoft Excel, Stripe** (+ Slack,
Gmail, Drive for messaging/filing). Each workflow below lists its trigger, the PRD behavior, a
proposed step graph (reusing existing step types where possible), and the new pieces required.

### 3.1 Expense Auditing
- **Trigger:** `finance.receipt.received` (Gmail push) — or `schedule.daily` batch.
- **PRD:** Gemini reads employee digital receipts, matches them against credit-card ledgers;
  Interlink matches transactions in QuickBooks, flags discrepancies, messages adjustments via Slack.
- **Step graph:** `plaid_fetch_txns` → `ai_extract_receipt` (Gemini: vendor/total/tax/line items
  as JSON) → `quickbooks_match_txn` → `branch` (discrepancy?) → `slack_message` (flag) / `log`.
- **New:** `plaid_fetch_txns`, `ai_extract_receipt` (new AI prompt+schema), `quickbooks_match_txn`,
  `slack_message`. **MVP cut:** start with receipt→structured-JSON extraction + discrepancy flag
  to Slack, stub the QuickBooks write behind a feature flag.

### 3.2 Dunning & Invoice Reminders
- **Trigger:** `schedule.weekly`.
- **PRD:** Gemini scans aged-receivables ledgers; for past-due balances, Interlink gathers contact
  details and schedules an automated email collection sequence.
- **Step graph:** `quickbooks_fetch_receivables` (or `stripe_fetch`) → `branch` (any overdue?) →
  loop: `ai_generate_email` (dunning tone, escalating) → `notify`/`wait_for_input` (approve send?)
  → `email_send` → `wait_until` (next escalation date) → repeat.
- **Reuse:** `ai_generate_email`, `notify`, `wait_for_input`, `email_send`, `wait_until` already exist.
  **New:** the receivables fetch step only. This is the **best first workflow to build** — lowest new surface.

### 3.3 Flash Financial Reporting
- **Trigger:** `schedule.daily`.
- **PRD:** Gemini reads daily banking transactions; Interlink updates a master sheet + cash-runway
  model and messages a summary to leadership.
- **Step graph:** `plaid_fetch_txns` → `ai_summarize_finances` (Gemini: JSON summary + runway calc)
  → `sheets_append` → `slack_message`/`email_send`.
- **New:** `plaid_fetch_txns`, `ai_summarize_finances`, `sheets_append`, `slack_message`.

### 3.4 Tax Document Gathering
- **Trigger:** `schedule.monthly` or `finance.threshold.crossed` (contractor pay ≥ threshold).
- **PRD:** Gemini monitors contractor payments; when thresholds require docs (e.g. 1099/W-9),
  Interlink emails requests for missing forms and files completed docs into secure folders.
- **Step graph:** `quickbooks_fetch_payments` → `branch` (threshold crossed & form missing?) →
  `ai_generate_email` (request form) → `email_send` → on reply: `drive_file` (store doc).
- **New:** payments fetch step, `drive_file`, and a reply-detection trigger (`finance.form.received`).

### 3.5 Regulatory Form Auto-Fill
- **Trigger:** `schedule.*` or manual.
- **PRD:** Gemini parses operational datasets and pre-populates fields on state compliance web portals.
- **Note:** Web-portal automation (no API) is the **hardest** and likely needs headless-browser
  RPA — **defer to last / out of initial scope.** The API-fillable subset can use `http_request`.

## 4. Suggested build phases

1. **AI provider plumbing** — add `GeminiProvider`; make provider selection per-mode; keep OpenAI
   default for Personal. Verify with a `demo`→`gemini` smoke test. *(No external account work.)*
2. **Scheduled trigger source** — emit `schedule.daily/weekly/monthly` triggers (QStash schedules).
3. **Workflow #2 (Dunning)** first — it reuses almost all existing steps; only needs one new
   data-fetch step. Proves the professional pipeline end-to-end with minimal new integration code.
4. **First integration** — pick **one** provider (recommend **Stripe** — cleanest API, good for
   receivables) end-to-end: OAuth/connect → encrypted tokens → fetch step → workflow.
5. **Expand** to Plaid/QuickBooks, then workflows #1, #3, #4. Defer #5 (RPA) indefinitely.

## 5. Open questions (decide before coding integrations)
- Which integration to wire **first** (Stripe vs Plaid vs QuickBooks)? Affects workflow #2 vs #1.
- Are accountant workflows **per-user** (each accountant connects their own QB/Stripe) or
  **per-organization** (shared books)? Changes the `connected_accounts` ownership model.
- Gemini model + API tier (affects the provider class config and the <2200ms / >98.5% PRD targets).
- How much **human approval** gating vs full autonomy for money-adjacent actions (refunds, sends)?

## Keep this current
Update step graphs here as workflows are actually implemented; log each implementation,
decision, and mistake in [BUILD-LOG.md](../../BUILD-LOG.md).
