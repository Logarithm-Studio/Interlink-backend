/**
 * GitHub adapter — the Product Manager persona's highest-signal source.
 *
 * Built on `GET /notifications`, GitHub's purpose-built endpoint: one call returns everything
 * awaiting the user across every repository. The obvious alternative — iterating repos and
 * calling `getPullRequests` on each — costs one request per repo, so its price scales with how
 * much code the user touches rather than how much actually needs them.
 *
 * THE ACTIONABLE BAR IS THE `reason` FIELD. GitHub tells you *why* it notified you, and only
 * some of those reasons mean a person is waiting:
 *   review_requested / assign / mention / team_mention  →  someone is blocked on you
 *   subscribed / comment / author / state_change        →  activity on something you watch
 * Only the first group becomes a hub item. Without this filter a busy repo would bury the feed
 * in its own noise within a day, which is the failure this product exists to prevent.
 */

import { getIntegration } from "../../integrations/tokenStore";
import { getNotifications } from "../../pm/github.service";
import { logger } from "../../../observability/logger";
import {
  upsertItem,
  markResolvedBySource,
  setSourceHealth,
  getCursor,
  setCursor,
  HUB_WEIGHTS,
} from "../hub.service";

/**
 * Reasons that mean a person is blocked on this user.
 *
 * `review_requested` is weighted highest: someone else literally cannot merge until you act.
 */
const BLOCKING_REASONS = new Set([
  "review_requested",
  "assign",
  "mention",
  "team_mention",
]);

const REASON_LABEL: Record<string, string> = {
  review_requested: "Review requested",
  assign: "Assigned to you",
  mention: "You were mentioned",
  team_mention: "Your team was mentioned",
};

/** GitHub is a work tool; there is one connection per user and no per-mode role. */
const GITHUB_MODE = "professional" as const;

export async function runGithubAdapter(userId: string): Promise<number> {
  const integration = await getIntegration(userId, "github");
  if (!integration || integration.status === "revoked") return 0;

  try {
    // `since` keeps the response small on every run after the first; the 7-day floor matches
    // the retention window so a long gap cannot pull in items the hub would immediately purge.
    const stored = await getCursor(userId, "github");
    const floor = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const since = stored && stored > floor ? stored : floor;

    const { items, pollIntervalSeconds } = await getNotifications(userId, since);

    const seen = new Set<string>();

    for (const n of items) {
      if (!BLOCKING_REASONS.has(n.reason)) continue;

      const dedupKey = `github:${n.id}`;
      seen.add(dedupKey);

      await upsertItem({
        userId,
        mode: GITHUB_MODE,
        source: "github",
        kind: "github_request",
        dedupKey,
        title: n.title,
        preview: `${REASON_LABEL[n.reason] ?? n.reason} · ${n.repoFullName}`,
        actor: n.repoFullName || "GitHub",
        weight:
          n.reason === "review_requested" ? HUB_WEIGHTS.approval : HUB_WEIGHTS.mail,
        externalRef: { githubId: n.id, url: n.url, repo: n.repoFullName },
        occurredAt: new Date(n.updatedAt),
      });
    }

    // GitHub drops a notification from the unread list once the user reads it anywhere, so
    // anything the hub holds that no longer appears has been handled — same inferred-resolution
    // shape as Gmail.
    await resolveDisappeared(userId, seen);

    await setCursor(userId, "github", new Date().toISOString(), true);
    await setSourceHealth(userId, "github", "ok");

    if (pollIntervalSeconds) {
      logger.info("[hub:github] poll interval advised by GitHub", {
        userId,
        pollIntervalSeconds,
      });
    }

    return seen.size;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[hub:github] poll failed", { userId, err: message });

    const needsReauth = /401|403|bad credentials|not connected/i.test(message);
    await setSourceHealth(
      userId,
      "github",
      needsReauth ? "reauth_required" : "error",
      needsReauth
        ? "Reconnect GitHub to keep review requests here."
        : "GitHub could not be reached on the last sync.",
    );
    await setCursor(userId, "github", null, false);
    return 0;
  }
}

async function resolveDisappeared(
  userId: string,
  stillOpen: Set<string>,
): Promise<void> {
  const { query } = await import("../../../config/db");
  const open = await query<{ dedup_key: string }>(
    `SELECT dedup_key FROM notification_items
      WHERE user_id = $1 AND source = 'github' AND state = 'open'`,
    [userId],
  );
  for (const row of open.rows) {
    if (!stillOpen.has(row.dedup_key)) {
      await markResolvedBySource(userId, row.dedup_key);
    }
  }
}
