-- Notification Hub — one cross-app queue of things waiting on the user.
--
-- WHY: Interlink brokers ~30 app connections for automation. Those same connections make it
-- the only place that can aggregate what needs the user's attention. The bar for a row here is
-- deliberately high: if the user does nothing, does something bad or slow happen? If no, it is
-- activity, not a notification, and it does not belong in this table.
--
-- This is NOT `notification_deliveries` (migration 017). That table is a per-channel delivery
-- audit trail keyed to workflow_executions — it records send attempts, not a readable feed.
--
-- RETENTION IS TIERED, and the tiers are the point:
--   0-7d  unresolved  -> full row + encrypted preview text
--   >7d   unresolved  -> preview stripped, row survives as a pointer (~300 bytes vs ~1KB)
--   >30d  unresolved  -> dropped
--   resolved/dismissed -> purged completely at 7d
-- Age alone was the wrong rule: an invoice overdue 30 days is exactly what the user asked us to
-- hold onto. State is the right rule; age only decides when the expensive part (text) goes.

BEGIN;

CREATE TABLE IF NOT EXISTS notification_items (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Which feed this belongs to. Classified by CONNECTION (google_accounts.role, or the tag set
  -- on a non-Google integration at connect time) — never by per-item AI classification, which
  -- costs a model call per item and is unexplainable when it gets it wrong.
  mode            text        NOT NULL CHECK (mode IN ('personal', 'professional')),

  source          text        NOT NULL,   -- internal | gmail | calendar | slack | github | jira | composio
  kind            text        NOT NULL,   -- invoice_overdue | gmail_thread | calendar_reschedule | ...

  -- PROVIDER-scoped, not adapter-scoped. A Gmail message arriving from both the native adapter
  -- and a Composio trigger must collapse into one row, so both write `gmail:<threadId>`.
  dedup_key       text        NOT NULL,

  title           text        NOT NULL,
  -- AES-256-GCM via the existing keyring, packed iv:tag:kid:ciphertext (same format as
  -- auth.service.ts / tokenStore.ts). NULL once stripped by the retention pass.
  preview_packed  text,
  actor           text,                    -- who it is from, when that is meaningful

  -- Shared vocabulary with dailyDigest.service.ts DigestLine.weight, so the digest and the feed
  -- can never disagree about what matters: meetings 5, approvals 4, overdue invoices 4,
  -- compliance 3, leads 2.
  weight          integer     NOT NULL DEFAULT 1,

  state           text        NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'resolved', 'dismissed')),

  -- Ids needed to deep-link or re-hydrate: threadId, messageId, invoice id, listing slug...
  external_ref    jsonb       NOT NULL DEFAULT '{}'::jsonb,

  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  text_purged_at  timestamptz
);

-- One row per thing. Re-running an adapter updates rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_items_dedup
  ON notification_items (user_id, dedup_key);

-- The feed query: flat, weight-ranked, newest-first within equal weight. No time sections —
-- those would sink an overdue invoice below a recent mention and hand the sorting back to the
-- user, which is the failure a chronological inbox already has.
CREATE INDEX IF NOT EXISTS idx_notification_items_feed
  ON notification_items (user_id, mode, state, weight DESC, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_items_open
  ON notification_items (user_id, occurred_at)
  WHERE state = 'open';

-- Retention sweeps scan by age across all users.
CREATE INDEX IF NOT EXISTS idx_notification_items_retention
  ON notification_items (state, occurred_at);


-- Per user per source. Gmail stores its historyId here; pull adapters store whatever cursor
-- lets them resume without rescanning.
CREATE TABLE IF NOT EXISTS notification_source_cursors (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source          text        NOT NULL,
  cursor          text,
  last_run_at     timestamptz,
  last_success_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source)
);


-- A hub that has silently stopped ingesting is WORSE than no hub, because the user has stopped
-- checking the real apps. This table backs the health line shown in the widget itself — not
-- buried in a settings screen nobody opens.
CREATE TABLE IF NOT EXISTS notification_source_health (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      text        NOT NULL,
  status      text        NOT NULL DEFAULT 'ok'
                CHECK (status IN ('ok', 'stale', 'reauth_required', 'error')),
  last_ok_at  timestamptz,
  message     text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source)
);

COMMIT;
