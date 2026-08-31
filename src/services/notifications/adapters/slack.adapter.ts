/**
 * Slack adapter — DMs and @mentions.
 *
 * WHAT QUALIFIES: a direct message, or a message that names you. Both are requests addressed to
 * you personally, which is the actionable bar. Channel chatter you happen to be a member of is
 * activity, not a decision, and pulling it in would rebuild the firehose this hub exists to
 * replace.
 *
 * SCOPES: this needs `im:read` + `im:history` (and `search:read` for mentions), which tokens
 * granted before 2026-08-31 do not carry. Rather than showing an empty Slack feed — which reads
 * as "nobody messaged you" and is the most damaging possible lie for a notification product —
 * the adapter reports `reauth_required` and the widget asks the user to reconnect.
 *
 * RESOLUTION mirrors Gmail: an item is resolved when the conversation's newest message is the
 * user's own. If you replied in Slack, the hub stops asking. Search-based mentions cannot be
 * resolved that way, so they age out through the normal retention tiers instead.
 */

import {
  getAuthedUserId,
  getConversationHistory,
  hasHubScopes,
  listDmConversations,
  searchMentions,
  type SlackDmMessage,
} from "../../slack/slack.service";
import { getIntegration } from "../../integrations/tokenStore";
import { logger } from "../../../observability/logger";
import {
  upsertItem,
  markResolvedBySource,
  setSourceHealth,
  HUB_WEIGHTS,
} from "../hub.service";

/** Matches the retention window — older messages are not live notifications. */
const WINDOW_DAYS = 7;
const MAX_CONVERSATIONS = 25;

/**
 * Slack lives in Professional mode.
 *
 * Unlike Google, there is one Slack connection per user with no per-mode role, and Slack is
 * overwhelmingly a work tool. If a user ever needs personal Slack, the fix is a mode tag on the
 * connection (the same "classify by connection" rule the rest of the hub uses) — not per-item
 * guessing.
 */
const SLACK_MODE = "professional" as const;

function slackTsToDate(ts: string): Date {
  // Slack timestamps are "<unix seconds>.<microseconds>".
  return new Date(Math.floor(Number(ts.split(".")[0]) * 1000));
}

function firstLine(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}

export async function runSlackAdapter(userId: string): Promise<number> {
  const integration = await getIntegration(userId, "slack");
  if (!integration) return 0;

  if (!(await hasHubScopes(userId))) {
    await setSourceHealth(
      userId,
      "slack",
      "reauth_required",
      "Reconnect Slack to bring your DMs and mentions here.",
    );
    return 0;
  }

  const me = await getAuthedUserId(userId);
  const since = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86_400;

  let written = 0;
  try {
    written += await directMessages(userId, me, since);
    written += await mentions(userId, me);
    await setSourceHealth(userId, "slack", "ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[hub:slack] poll failed", { userId, err: message });

    const needsReauth = /missing_scope|invalid_auth|not_authed|token_revoked/i.test(message);
    await setSourceHealth(
      userId,
      "slack",
      needsReauth ? "reauth_required" : "error",
      needsReauth
        ? "Reconnect Slack to bring your DMs and mentions here."
        : "Slack could not be reached on the last sync.",
    );
  }

  return written;
}

/** One item per DM conversation, carrying its newest inbound message. */
async function directMessages(
  userId: string,
  me: string | null,
  since: number,
): Promise<number> {
  const channels = (await listDmConversations(userId)).slice(0, MAX_CONVERSATIONS);

  let written = 0;
  for (const channel of channels) {
    let history: SlackDmMessage[];
    try {
      history = await getConversationHistory(userId, channel, since, 20);
    } catch {
      // One unreadable conversation must not cost the user the other twenty-four.
      continue;
    }
    if (history.length === 0) continue;

    // conversations.history returns newest first.
    const newest = history[0];
    const dedupKey = `slack:dm:${channel}`;

    // The last word is mine — nothing is waiting on me here.
    if (me && newest.user === me) {
      await markResolvedBySource(userId, dedupKey);
      continue;
    }

    await upsertItem({
      userId,
      mode: SLACK_MODE,
      source: "slack",
      kind: "slack_dm",
      dedupKey,
      title: "Direct message",
      preview: firstLine(newest.text),
      actor: newest.user ? `<@${newest.user}>` : "Slack",
      weight: HUB_WEIGHTS.mail,
      externalRef: {
        channel,
        ts: newest.ts,
        deepLink: `slack://channel?id=${channel}`,
      },
      occurredAt: slackTsToDate(newest.ts),
    });
    written += 1;
  }

  return written;
}

/**
 * Messages that name the user.
 *
 * Failures here are swallowed on purpose: `search.messages` is not available on every Slack
 * plan, and losing mentions is a far smaller loss than losing DMs to a thrown error.
 */
async function mentions(userId: string, me: string | null): Promise<number> {
  if (!me) return 0;

  let matches: Awaited<ReturnType<typeof searchMentions>>;
  try {
    matches = await searchMentions(userId, me, 20);
  } catch (err) {
    logger.info("[hub:slack] mention search unavailable — DMs only", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;

  let written = 0;
  for (const match of matches) {
    const occurredAt = slackTsToDate(match.ts);
    if (occurredAt.getTime() < cutoff) continue;

    await upsertItem({
      userId,
      mode: SLACK_MODE,
      source: "slack",
      kind: "slack_mention",
      dedupKey: `slack:mention:${match.ts}`,
      title: `Mentioned in #${match.channelName}`,
      preview: firstLine(match.text),
      actor: `#${match.channelName}`,
      weight: HUB_WEIGHTS.mail,
      externalRef: { permalink: match.permalink, ts: match.ts },
      occurredAt,
    });
    written += 1;
  }

  return written;
}
