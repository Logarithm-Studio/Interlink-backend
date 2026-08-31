/**
 * Per-app event alerts — "something happened in a connected app, come look".
 *
 * Composio exposes TRIGGERS: it watches a connected account and POSTs a webhook when
 * something happens (new Gmail message, Slack DM, HubSpot deal moved, calendar event
 * starting soon). We turn those into push notifications through the same
 * `deliverNotification` path as the daily digest.
 *
 * SCOPE — this only covers apps connected THROUGH Composio. Natively-connected apps
 * (Google, Slack, GitHub, Notion) don't have Composio trigger instances; they'd need their
 * own polling/webhooks. Documented rather than silently half-working.
 *
 * CURATION — deliberately NOT a firehose. Every trigger event costs Composio quota and, more
 * importantly, a user's attention. We enable a small high-signal set per toolkit and let the
 * user opt in per app; nobody wants a push for every channel message they're cc'd on.
 *
 * SECURITY — Composio posts to a URL we configure, so we append a secret and verify it on the
 * way in. Without that, anyone who guessed the path could fabricate notifications.
 */

import { createHash } from "crypto";
import type { Composio } from "@composio/core";
import { query } from "../../config/db";
import { logger } from "../../observability/logger";
import { upsertItem, HUB_WEIGHTS } from "../notifications/hub.service";
import { getComposioClient, toolkitName, isKnownToolkit } from "./composio.service";

/** High-signal triggers per toolkit. Keys are Composio toolkit slugs. */
export const EVENT_ALERT_TRIGGERS: Record<string, string[]> = {
  gmail: ["GMAIL_NEW_GMAIL_MESSAGE"],
  slack: ["SLACK_DIRECT_MESSAGE_RECEIVED"],
  hubspot: ["HUBSPOT_DEAL_STAGE_UPDATED_TRIGGER", "HUBSPOT_CONTACT_CREATED_TRIGGER"],
  googlecalendar: ["GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER"],

  // Notification Hub focus personas — VERIFIED against Composio's live catalogue 2026-08-31.
  //
  // Finance: a failed payment is money that stops arriving unless someone acts, which is exactly
  // the bar. (Note the slugs: an earlier guess used STRIPE_INVOICE_PAYMENT_FAILED, which does not
  // exist. Verify slugs before adding a toolkit — `enableEventAlerts` tolerates a bad one, so a
  // wrong name fails silently rather than loudly.)
  stripe: ["STRIPE_PAYMENT_FAILED_TRIGGER", "STRIPE_CHARGE_FAILED_TRIGGER"],
};

/**
 * Toolkits deliberately NOT wired for alerts, and why. Checked against Composio 2026-08-31 —
 * do not re-add without re-checking, and do not assume a toolkit having *tools* means it has
 * *triggers*.
 *
 * NO TRIGGERS EXIST AT ALL (Composio exposes tools for these, but nothing to subscribe to):
 *   - quickbooks
 *   - xero
 *   - docusign   ← this was to be the Real Estate persona's Composio source. It cannot be.
 *                  Real Estate therefore has no third-party notification source at all, which
 *                  is precisely why listing-view tracking on our own public page matters.
 *
 * TRIGGERS EXIST BUT NONE MEET THE ACTIONABLE BAR:
 *   - linear: only ISSUE_CREATED / ISSUE_UPDATED / COMMENT_EVENT — workspace-wide. There is no
 *     "assigned to me" trigger, and subscribing to every issue in a workspace rebuilds the
 *     firehose this hub exists to replace. Product Manager is served by the native GitHub and
 *     Jira adapters instead, which CAN filter to "waiting on you".
 *   - asana: same shape — TASK_CREATED / TASK_UPDATED / TASK_COMMENT_ADDED, no assignment event.
 */
export const DELIBERATELY_UNWIRED_TOOLKITS = {
  noTriggersAvailable: ["quickbooks", "xero", "docusign"],
  tooNoisyToQualify: ["linear", "asana"],
} as const;

export function alertableToolkits(): string[] {
  return Object.keys(EVENT_ALERT_TRIGGERS);
}

/** Shared secret appended to the webhook URL so only Composio can post events. */
export function webhookSecret(): string {
  const base =
    process.env.COMPOSIO_WEBHOOK_SECRET ||
    process.env.ACTION_SIGNING_SECRET ||
    process.env.ENCRYPTION_KEY ||
    "";
  return createHash("sha256").update(`composio-webhook:${base}`).digest("hex").slice(0, 32);
}

export function webhookUrl(): string {
  const base = process.env.API_BASE_URL ?? "http://localhost:5000";
  return `${base}/api/v1/composio/webhook?key=${webhookSecret()}`;
}

/**
 * Point Composio's trigger webhook at us. Safe to call repeatedly — Composio treats it as
 * an upsert of the account-level subscription.
 */
export async function ensureWebhookSubscription(composio: Composio): Promise<void> {
  try {
    const t = composio.triggers as unknown as {
      setWebhookSubscription?: (url: string) => Promise<unknown>;
    };
    if (typeof t.setWebhookSubscription === "function") {
      await t.setWebhookSubscription(webhookUrl());
    }
  } catch (err) {
    logger.warn("[composio-triggers] setWebhookSubscription failed", { err: String(err) });
  }
}

/** Trigger instances currently active for this user, as toolkit slugs. */
export async function listEnabledAlertToolkits(userId: string): Promise<string[]> {
  const composio = await getComposioClient();
  if (!composio) return [];
  try {
    const res = await composio.triggers.listActive({ });
    const items = ((res as { items?: unknown[] })?.items ?? []) as Record<string, unknown>[];
    const slugs = new Set<string>();
    for (const it of items) {
      // Only this user's instances; shape varies slightly across SDK versions.
      const owner = String(it.userId ?? it.user_id ?? "");
      if (owner && owner !== userId) continue;
      const toolkit = String(
        (it.toolkit as { slug?: string } | undefined)?.slug ?? it.toolkitSlug ?? "",
      ).toLowerCase();
      const name = String(it.triggerName ?? it.slug ?? "");
      const resolved = toolkit || name.split("_")[0]?.toLowerCase() || "";
      if (resolved && EVENT_ALERT_TRIGGERS[resolved]) slugs.add(resolved);
    }
    return [...slugs];
  } catch (err) {
    logger.warn("[composio-triggers] listActive failed", { err: String(err) });
    return [];
  }
}

/** Turn on this toolkit's curated alerts for the user. */
export async function enableEventAlerts(
  userId: string,
  toolkitSlug: string,
): Promise<{ enabled: string[]; failed: string[] }> {
  const composio = await getComposioClient();
  const enabled: string[] = [];
  const failed: string[] = [];
  const slugs = EVENT_ALERT_TRIGGERS[toolkitSlug];
  if (!composio || !slugs) return { enabled, failed: slugs ?? [] };

  await ensureWebhookSubscription(composio);

  // Composio needs an explicit connectedAccountId once a user has more than one connected
  // account — otherwise it warns and picks "the first one", which may be the wrong app.
  let connectedAccountId: string | undefined;
  try {
    const accounts = await composio.connectedAccounts.list({ userIds: [userId] });
    connectedAccountId = (accounts.items ?? []).find(
      (a) => a.toolkit?.slug?.toLowerCase() === toolkitSlug && a.status === "ACTIVE",
    )?.id;
  } catch (err) {
    logger.warn("[composio-triggers] could not resolve connected account", { toolkitSlug, err: String(err) });
  }
  if (!connectedAccountId) return { enabled, failed: slugs };

  for (const slug of slugs) {
    try {
      // Empty triggerConfig -> Composio applies the trigger type's defaults. Configs differ
      // per trigger (poll interval, calendar id, …) and guessing them 400s the request.
      await composio.triggers.create(userId, slug, { connectedAccountId, triggerConfig: {} });
      enabled.push(slug);
    } catch (err) {
      failed.push(slug);
      // A 422 TriggerInstance_AuthRefreshRequired means the upstream app rejected the account
      // (e.g. a vendor dev-mode allow-list) — surfaced to the caller as a failed slug.
      logger.warn("[composio-triggers] enable failed", { slug, err: String(err).slice(0, 200) });
    }
  }
  return { enabled, failed };
}

/** Turn off every active trigger instance for this toolkit. */
export async function disableEventAlerts(userId: string, toolkitSlug: string): Promise<number> {
  const composio = await getComposioClient();
  if (!composio) return 0;
  let removed = 0;
  try {
    const res = await composio.triggers.listActive({ });
    const items = ((res as { items?: unknown[] })?.items ?? []) as Record<string, unknown>[];
    for (const it of items) {
      const owner = String(it.userId ?? it.user_id ?? "");
      if (owner && owner !== userId) continue;
      const name = String(it.triggerName ?? it.slug ?? "");
      const toolkit = String(
        (it.toolkit as { slug?: string } | undefined)?.slug ?? it.toolkitSlug ?? "",
      ).toLowerCase();
      const resolved = toolkit || name.split("_")[0]?.toLowerCase();
      if (resolved !== toolkitSlug) continue;
      const id = String(it.id ?? it.triggerId ?? "");
      if (!id) continue;
      try {
        await composio.triggers.delete(id);
        removed += 1;
      } catch {
        try {
          await composio.triggers.disable(id);
          removed += 1;
        } catch (err) {
          logger.warn("[composio-triggers] disable failed", { id, err: String(err).slice(0, 150) });
        }
      }
    }
  } catch (err) {
    logger.warn("[composio-triggers] disable listActive failed", { err: String(err) });
  }
  return removed;
}

// ─── Incoming events → notifications ──────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Turn an arbitrary trigger payload into a short push. Deliberately generic: Composio's
 * payload shape differs per trigger, so we pick the first recognizable "who/what" fields
 * rather than hardcoding a parser per app (which would silently break on new triggers).
 */
export function describeTriggerEvent(
  triggerSlug: string,
  payload: Record<string, unknown>,
): { title: string; body: string } {
  const toolkit = triggerSlug.split("_")[0]?.toLowerCase() ?? "";
  const app = isKnownToolkit(toolkit) ? toolkitName(toolkit) : toolkit || "Connected app";

  const subject = str(payload.subject) || str(payload.title) || str(payload.name);
  const from =
    str(payload.sender) || str(payload.from) || str(payload.user) || str(payload.userName);
  const text = str(payload.text) || str(payload.message) || str(payload.body);

  if (/NEW_GMAIL_MESSAGE/i.test(triggerSlug)) {
    return { title: `New email${from ? ` from ${from}` : ""}`, body: subject || text || "Open Interlink to read it." };
  }
  if (/DIRECT_MESSAGE|CHANNEL_MESSAGE/i.test(triggerSlug)) {
    return { title: `Slack message${from ? ` from ${from}` : ""}`, body: text || "Open Interlink to reply." };
  }
  if (/DEAL_STAGE_UPDATED/i.test(triggerSlug)) {
    return { title: "Deal stage changed", body: subject || "A HubSpot deal moved stage." };
  }
  if (/CONTACT_CREATED/i.test(triggerSlug)) {
    return { title: "New contact", body: subject || from || "A new HubSpot contact was created." };
  }
  if (/EVENT_STARTING_SOON/i.test(triggerSlug)) {
    return { title: "Starting soon", body: subject || "You have an event starting shortly." };
  }

  const detail = subject || text || from;
  return { title: `${app} update`, body: detail || `Something changed in ${app}.` };
}

/**
 * Handle one inbound Composio trigger webhook. Always resolves; a bad payload must never
 * 500 back to Composio (it would retry forever).
 */

/**
 * A stable identity for a webhook event.
 *
 * Prefers whatever id the provider sent (message id, thread id, invoice id, envelope id) so a
 * Composio retry — or the native adapter seeing the same thing — updates one row instead of
 * creating a second. Falls back to a per-minute bucket, which preserves the old idempotency
 * behaviour when the payload carries nothing identifying.
 */
function composioDedupKey(
  triggerSlug: string,
  payload: Record<string, unknown>,
): string {
  const idFields = [
    "thread_id", "threadId",
    "message_id", "messageId",
    "id", "invoice_id", "envelope_id", "issue_id", "task_id",
  ];

  for (const field of idFields) {
    const value = payload[field];
    if (typeof value === "string" && value.trim()) {
      // Gmail arriving via Composio must land on the SAME key the native adapter writes,
      // or the user sees the message twice.
      if (triggerSlug.startsWith("GMAIL") && (field.startsWith("thread") || field === "id")) {
        return `gmail:${value}`;
      }
      return `composio:${triggerSlug}:${value}`;
    }
  }

  const minute = new Date().toISOString().slice(0, 16);
  return `composio:${triggerSlug}:${minute}`;
}

export async function handleTriggerEvent(raw: Record<string, unknown>): Promise<boolean> {
  try {
    const triggerSlug = str(raw.triggerSlug) || str(raw.triggerName) || str(raw.type) || "UNKNOWN";
    const userId =
      str(raw.userId) ||
      str((raw.metadata as Record<string, unknown> | undefined)?.userId) ||
      str((raw.data as Record<string, unknown> | undefined)?.userId);
    if (!userId) {
      logger.warn("[composio-triggers] event without userId", { triggerSlug });
      return false;
    }

    // Only notify users we actually know about.
    const known = await query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (!known.rows[0]) return false;

    const payload = ((raw.payload ?? raw.data ?? {}) as Record<string, unknown>) || {};
    const { title, body } = describeTriggerEvent(triggerSlug, payload);

    // Write to the Notification Hub instead of pushing.
    //
    // This used to call `deliverNotification` and fire an immediate FCM push. That made the SAME
    // event behave differently depending on a detail the user never thinks about: a Gmail account
    // connected through Composio interrupted them, while one connected natively landed silently
    // in the hub. Items land silently now; the daily digest remains the once-a-day interruption.
    //
    // The dedup key is PROVIDER-scoped, not adapter-scoped, so a message arriving from both the
    // native adapter and this webhook collapses into one row rather than two.
    const dedupKey = composioDedupKey(triggerSlug, payload);

    await upsertItem({
      userId,
      // Composio toolkits are work tools; there is one connection per user with no per-mode role.
      mode: "professional",
      source: "composio",
      kind: `composio_${triggerSlug.toLowerCase()}`,
      dedupKey,
      title,
      preview: body.slice(0, 180),
      actor: toolkitName(triggerSlug.split("_")[0]?.toLowerCase() ?? "") || "Connected app",
      weight: HUB_WEIGHTS.mail,
      externalRef: { triggerSlug },
      occurredAt: new Date(),
    });
    return true;
  } catch (err) {
    logger.warn("[composio-triggers] handleTriggerEvent failed", { err: String(err) });
    return false;
  }
}
