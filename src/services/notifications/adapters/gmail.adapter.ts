/**
 * Gmail adapter — PULL, not push.
 *
 * WHY PULL: `users.watch` + Pub/Sub is the "proper" realtime path, but it needs a GCP topic, a
 * subscription, and a `pubsub.publisher` grant to Google's push service account — console work
 * only the project owner can do. Pull runs today on the already-granted `gmail.readonly` with no
 * setup, and swaps to push later without changing the adapter contract or the stored rows.
 *
 * WHY A SEARCH QUERY RATHER THAN `history.list`: the hub only wants mail that is still *waiting*.
 * A query for unread, non-bulk, recent inbox mail answers that directly, and — the important part
 * — it doubles as **inferred resolution**. Anything the hub is holding that no longer comes back
 * in the query has been read, replied to, or archived by the user somewhere else, so it is
 * resolved. `history.list` would have needed a separate per-thread check to learn the same thing.
 * Without that, the feed starts lying within a week: it confidently shows mail the user handled
 * on their laptop, and `gmail.modify` (which we do NOT have) is the only way to mutate Gmail's
 * own state.
 *
 * ACCOUNT SCOPING: a user can connect a Personal and a Work Google account. Each is polled
 * separately and its items are tagged with that account's mode, so work mail never lands in the
 * personal feed.
 */

import {
  listGmailMailboxMessages,
  type GmailMessageSummary,
} from "../../googleApi.service";
import { listGoogleAccounts } from "../../auth.service";
import { query } from "../../../config/db";
import { logger } from "../../../observability/logger";
import {
  upsertItem,
  markResolvedBySource,
  setSourceHealth,
  setCursor,
  HUB_WEIGHTS,
  type HubMode,
} from "../hub.service";

/**
 * The actionable bar, expressed as a Gmail query.
 *
 * - `is:unread in:inbox` — still waiting on the user.
 * - `newer_than:7d` — matches the retention window; older mail is not a live notification.
 * - `-category:promotions -category:social -category:updates` — bulk mail is activity, not a
 *   decision. Without this the hub becomes the firehose it exists to replace.
 */
const ACTIONABLE_QUERY =
  "is:unread in:inbox newer_than:7d -category:promotions -category:social -category:updates";

const MAX_PER_ACCOUNT = 25;

/** "Ada Lovelace <ada@example.com>" -> "Ada Lovelace"; bare addresses pass through. */
function displayName(from: string | null): string | null {
  if (!from) return null;
  const match = from.match(/^\s*"?([^"<]+?)"?\s*<.+>\s*$/);
  return (match ? match[1] : from).trim() || null;
}

export async function runGmailAdapter(userId: string): Promise<number> {
  const accounts = await listGoogleAccounts(userId);
  if (accounts.length === 0) return 0;

  let written = 0;

  for (const account of accounts) {
    // A Google account needing re-auth cannot be polled. Say so in the widget rather than
    // letting the feed quietly go stale while the user believes they are caught up.
    if (account.reauthRequired) {
      await setSourceHealth(
        userId,
        "gmail",
        "reauth_required",
        `Reconnect ${account.email ?? "your Google account"} to keep mail flowing.`,
      );
      continue;
    }

    // An account with no explicit role is treated as personal — matches how the rest of the
    // codebase falls back when `X-Interlink-Mode` is absent.
    const mode: HubMode = account.role === "professional" ? "professional" : "personal";

    try {
      const result = await listGmailMailboxMessages({
        userId,
        googleAccountId: account.id,
        mailbox: "inbox",
        maxResults: MAX_PER_ACCOUNT,
        query: ACTIONABLE_QUERY,
      });

      // One row per THREAD, not per message: five replies in one argument is one decision.
      const byThread = new Map<string, GmailMessageSummary>();
      for (const message of result.messages) {
        const existing = byThread.get(message.threadId);
        const newer =
          !existing ||
          Number(message.internalDate ?? 0) > Number(existing.internalDate ?? 0);
        if (newer) byThread.set(message.threadId, message);
      }

      const seen = new Set<string>();

      for (const [threadId, message] of byThread) {
        const dedupKey = `gmail:${threadId}`;
        seen.add(dedupKey);

        await upsertItem({
          userId,
          mode,
          source: "gmail",
          kind: "gmail_thread",
          dedupKey,
          title: message.subject?.trim() || "(no subject)",
          preview: message.snippet,
          actor: displayName(message.from),
          weight: HUB_WEIGHTS.mail,
          externalRef: {
            threadId,
            messageId: message.id,
            googleAccountId: account.id,
            // Route into Interlink's own Mails tab, which already lists threads, opens detail
            // and can send replies. Ejecting the user into Gmail hands the session to another
            // app and guarantees the success metric looks terrible.
            route: mode === "professional" ? "/(work)/mails" : "/(home)/mails",
          },
          occurredAt: message.internalDate
            ? new Date(Number(message.internalDate))
            : new Date(),
        });
        written += 1;
      }

      await resolveDisappeared(userId, account.id, seen);
      await setCursor(userId, "gmail", null, true);
      await setSourceHealth(userId, "gmail", "ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("[hub:gmail] poll failed", {
        userId,
        accountId: account.id,
        err: message,
      });

      // Distinguish a revoked/expired grant from a transient outage on the FIRST failure.
      // A refresh failure flags the account `reauth_required` in google_accounts, so the next
      // run would classify it correctly anyway — but the user sees the widget now, and
      // "Reconnect your account" is actionable where "could not be reached" is not.
      const needsReauth =
        /invalid_grant|invalid_token|unauthorized|401|403/i.test(message);

      await setSourceHealth(
        userId,
        "gmail",
        needsReauth ? "reauth_required" : "error",
        needsReauth
          ? `Reconnect ${account.email ?? "your Google account"} to keep mail flowing.`
          : "Gmail could not be reached on the last sync.",
      );
      await setCursor(userId, "gmail", null, false);
    }
  }

  return written;
}

/**
 * Inferred resolution.
 *
 * Any open Gmail item for this account that did NOT come back in the actionable query has been
 * read, replied to, or archived elsewhere — so it is no longer waiting on the user. Resolving it
 * here is what keeps the hub honest without `gmail.modify`.
 *
 * Scoped to `googleAccountId` so polling the Work account never resolves Personal items.
 */
async function resolveDisappeared(
  userId: string,
  googleAccountId: string,
  stillActionable: Set<string>,
): Promise<void> {
  const open = await query<{ dedup_key: string }>(
    `SELECT dedup_key
       FROM notification_items
      WHERE user_id = $1
        AND source = 'gmail'
        AND state = 'open'
        AND external_ref->>'googleAccountId' = $2`,
    [userId, googleAccountId],
  );

  for (const row of open.rows) {
    if (!stillActionable.has(row.dedup_key)) {
      await markResolvedBySource(userId, row.dedup_key);
    }
  }
}
