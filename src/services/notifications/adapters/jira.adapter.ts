/**
 * Jira adapter.
 *
 * The cheapest adapter in the set: `searchIssues` already exists and already speaks JQL, so the
 * whole thing is one query plus a diff. JQL also lets the actionable bar be expressed *server
 * side* — we ask Jira only for issues assigned to this user and still unresolved, rather than
 * pulling a project's activity and filtering locally.
 *
 * `pm.vertical.ts` runs a similar query for the PM snapshot; this one is deliberately narrower.
 * The snapshot wants situational awareness ("what moved this week"); the hub wants only what is
 * assigned to you and not done. Recently-updated issues you are merely watching are activity.
 */

import { getIntegration } from "../../integrations/tokenStore";
import { searchIssues } from "../../jira/jira.service";
import { logger } from "../../../observability/logger";
import {
  upsertItem,
  markResolvedBySource,
  setSourceHealth,
  setCursor,
  HUB_WEIGHTS,
} from "../hub.service";
import { query } from "../../../config/db";

/**
 * Assigned to me, not done. `ORDER BY updated DESC` so the most recently touched come first
 * when the result is capped.
 */
const HUB_JQL =
  "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";

/** Priorities Jira exposes that genuinely change urgency. Everything else takes the base weight. */
const URGENT_PRIORITIES = new Set(["Highest", "High", "Critical", "Blocker"]);

const JIRA_MODE = "professional" as const;

export async function runJiraAdapter(userId: string): Promise<number> {
  try {
    // Inside the try on purpose: this decrypts a stored token, so a rotated/missing keyring key
    // throws here. Outside, that exception escaped the adapter — the QStash job failed and
    // `notification_source_health` was never written, so the user's banner never learned the
    // source had stopped. A source that stalls silently is the exact failure the hub exists to
    // prevent, so a credential failure must be RECORDED, not thrown.
    const integration = await getIntegration(userId, "jira");
    if (!integration || integration.status === "revoked") return 0;

    const issues = await searchIssues(userId, HUB_JQL);
    const seen = new Set<string>();

    for (const issue of issues.slice(0, 30)) {
      const dedupKey = `jira:${issue.key}`;
      seen.add(dedupKey);

      await upsertItem({
        userId,
        mode: JIRA_MODE,
        source: "jira",
        kind: "jira_assigned",
        dedupKey,
        title: `${issue.key} — ${issue.summary}`,
        preview: issue.priority
          ? `${issue.status} · ${issue.priority} priority`
          : issue.status,
        actor: "Jira",
        weight:
          issue.priority && URGENT_PRIORITIES.has(issue.priority)
            ? HUB_WEIGHTS.approval
            : HUB_WEIGHTS.lead,
        externalRef: { key: issue.key, url: issue.url, status: issue.status },
        // Jira's search does not return a per-issue timestamp in the fields we request, and
        // adding one would mean widening the shared `searchIssues` projection for every caller.
        // Ordering is by weight first anyway, so "now" is honest enough here: the item entered
        // the hub now. `upsertItem` refreshes this on each run without creating duplicates.
        occurredAt: new Date(),
      });
    }

    // Resolved, reassigned or closed in Jira → no longer waiting on this user.
    const open = await query<{ dedup_key: string }>(
      `SELECT dedup_key FROM notification_items
        WHERE user_id = $1 AND source = 'jira' AND state = 'open'`,
      [userId],
    );
    for (const row of open.rows) {
      if (!seen.has(row.dedup_key)) {
        await markResolvedBySource(userId, row.dedup_key);
      }
    }

    await setCursor(userId, "jira", new Date().toISOString(), true);
    await setSourceHealth(userId, "jira", "ok");
    return seen.size;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[hub:jira] poll failed", { userId, err: message });

    const needsReauth = /401|403|unauthor|invalid_grant|not connected/i.test(message);
    await setSourceHealth(
      userId,
      "jira",
      needsReauth ? "reauth_required" : "error",
      needsReauth
        ? "Reconnect Jira to keep your assigned issues here."
        : "Jira could not be reached on the last sync.",
    );
    await setCursor(userId, "jira", null, false);
    return 0;
  }
}
