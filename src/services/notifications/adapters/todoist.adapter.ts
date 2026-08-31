/**
 * Todoist adapter.
 *
 * Todoist is the one deferred Wave-2 source that both has a real connected user and a clean
 * primitive to build on: `getTasks` already returns every open task with its due date, so the
 * actionable bar is a date comparison rather than a heuristic.
 *
 * ONLY DUE AND OVERDUE TASKS QUALIFY. An undated task in someone's Todoist is a personal
 * backlog, not something waiting on them — if it were included, a user with 200 someday-tasks
 * would drown every genuine item in the hub, and the feed would stop being trustworthy. A task
 * dated today or earlier is the opposite: do nothing and it slips, which is exactly the
 * inclusion bar.
 *
 * Personal mode, because Todoist here is a personal task list; the professional verticals track
 * their own work in `internal`.
 */

import { getIntegration } from "../../integrations/tokenStore";
import { getTasks, type TodoistTask } from "../../todoist/todoist.service";
import { logger } from "../../../observability/logger";
import {
  upsertItem,
  markResolvedBySource,
  setSourceHealth,
  setCursor,
  HUB_WEIGHTS,
} from "../hub.service";
import { query } from "../../../config/db";

const TODOIST_MODE = "personal" as const;

/** Todoist priority is inverted: 4 is "p1"/urgent in the UI, 1 is the default. */
const URGENT_PRIORITY = 4;

/**
 * Todoist due dates are floating local dates ("2026-08-31"), not instants — a task due today is
 * due in the user's own day, whatever their timezone. Comparing against a UTC-derived
 * `YYYY-MM-DD` is therefore the honest comparison, and avoids a task flipping to overdue at
 * 18:00 for a user behind UTC.
 */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The inclusion rule, extracted so it can be tested without a Todoist token.
 *
 * Keeps only open tasks dated today or earlier, oldest first — the most overdue is the most
 * urgent within a weight band. Undated tasks are someone's backlog, not a thing waiting on them.
 */
export function selectActionableTasks(
  tasks: TodoistTask[],
  today: string,
): TodoistTask[] {
  return tasks
    .filter((t) => !t.isCompleted && !!t.due?.date && t.due.date.slice(0, 10) <= today)
    .sort((a, b) => (a.due!.date < b.due!.date ? -1 : 1));
}

export async function runTodoistAdapter(userId: string): Promise<number> {
  try {
    // Inside the try on purpose: this decrypts a stored token, so a rotated/missing keyring key
    // throws here. Outside, that exception escaped the adapter — the QStash job failed and
    // `notification_source_health` was never written, so the user's banner never learned the
    // source had stopped. A source that stalls silently is the exact failure the hub exists to
    // prevent, so a credential failure must be RECORDED, not thrown.
    const integration = await getIntegration(userId, "todoist");
    if (!integration || integration.status === "revoked") return 0;

    const tasks = await getTasks(userId);
    const today = todayKey();
    const seen = new Set<string>();

    const due = selectActionableTasks(tasks, today);

    for (const task of due.slice(0, 30)) {
      const dedupKey = `todoist:${task.id}`;
      seen.add(dedupKey);

      const dueDate = task.due!.date.slice(0, 10);
      const overdue = dueDate < today;

      await upsertItem({
        userId,
        mode: TODOIST_MODE,
        source: "todoist",
        kind: overdue ? "todoist_overdue" : "todoist_due",
        dedupKey,
        title: task.content,
        // `due.string` is Todoist's own human phrasing ("every Monday", "tomorrow at 9"), which
        // is friendlier than re-formatting the ISO date ourselves.
        preview: overdue
          ? `Overdue — was due ${task.due!.string || dueDate}`
          : `Due ${task.due!.string || "today"}`,
        actor: "Todoist",
        weight:
          overdue || task.priority === URGENT_PRIORITY
            ? HUB_WEIGHTS.approval
            : HUB_WEIGHTS.lead,
        externalRef: {
          taskId: task.id,
          url: `https://app.todoist.com/app/task/${task.id}`,
          due: dueDate,
        },
        occurredAt: new Date(`${dueDate}T00:00:00Z`),
      });
    }

    // Completed, rescheduled into the future, or deleted in Todoist → no longer waiting.
    const open = await query<{ dedup_key: string }>(
      `SELECT dedup_key FROM notification_items
        WHERE user_id = $1 AND source = 'todoist' AND state = 'open'`,
      [userId],
    );
    for (const row of open.rows) {
      if (!seen.has(row.dedup_key)) {
        await markResolvedBySource(userId, row.dedup_key);
      }
    }

    await setCursor(userId, "todoist", new Date().toISOString(), true);
    await setSourceHealth(userId, "todoist", "ok");
    return seen.size;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[hub:todoist] poll failed", { userId, err: message });

    const needsReauth = /401|403|unauthor|invalid_grant|not connected/i.test(message);
    await setSourceHealth(
      userId,
      "todoist",
      needsReauth ? "reauth_required" : "error",
      needsReauth
        ? "Reconnect Todoist to keep your due tasks here."
        : "Todoist could not be reached on the last sync.",
    );
    await setCursor(userId, "todoist", null, false);
    return 0;
  }
}
