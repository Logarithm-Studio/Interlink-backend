/**
 * Professional autonomy engine — the persona-agnostic sibling of the finance
 * `automationRunner.service`. For each user×persona with enabled automations,
 * runs each due `AutomationDef.plan()` and, per autonomy level:
 *   - Auto    → performs each proposal via the vertical's `executeTool` (capped).
 *   - Suggest → records a `suggested` activity (+ push) for one-tap approval.
 * Everything lands in the shared persona-tagged activity feed.
 */

import { query } from "../../config/db";
import { AppUser } from "../../types";
import { sendPushNotification } from "../notifications/push.service";
import {
  getActivity,
  hasPendingSuggestion,
  recordActivity,
  setActivityStatus,
} from "../accountant/activity.service";
import { getVertical } from "./registry";
import { getProfessionalAutomations } from "./automations.service";

const DAY_MS = 86_400_000;
const AUTO_CAP = 5; // max auto-executed proposals per automation per tick

async function loadUser(userId: string): Promise<AppUser | null> {
  const res = await query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  return res.rows[0] ? { id: res.rows[0].id, email: res.rows[0].email } : null;
}

function isDue(lastRunAt: Date | null, cadenceDays: number): boolean {
  if (!lastRunAt) return true;
  return Date.now() - new Date(lastRunAt).getTime() >= cadenceDays * DAY_MS;
}

async function touchLastRun(userId: string, persona: string, type: string): Promise<void> {
  await query(
    `UPDATE professional_automations SET last_run_at = now(), updated_at = now()
      WHERE user_id = $1 AND persona = $2 AND type = $3`,
    [userId, persona, type],
  );
}

export interface RunSummary {
  ran: string[];
  suggested: number;
  acted: number;
}

/** Run all due automations for one user in one persona. */
export async function runProfessionalAutomationsForUser(
  user: AppUser,
  persona: string,
): Promise<RunSummary> {
  const vertical = getVertical(persona);
  if (!vertical?.automations?.length) return { ran: [], suggested: 0, acted: 0 };

  const states = await getProfessionalAutomations(user.id, persona);
  const summary: RunSummary = { ran: [], suggested: 0, acted: 0 };

  for (const def of vertical.automations) {
    const state = states.find((s) => s.type === def.type);
    if (!state || !state.enabled || state.autonomy === "off") continue;
    if (!isDue(state.lastRunAt, def.cadenceDays)) continue;

    const proposals = await def.plan(user.id).catch(() => []);
    let acted = 0;
    for (const p of proposals) {
      if (state.autonomy === "auto") {
        if (acted >= AUTO_CAP) break;
        try {
          const res = await vertical.executeTool(user, p.tool, p.args);
          if (res.ok) acted++;
        } catch {
          // executeTool already guards; ignore per-item failure.
        }
      } else {
        // Suggest — queue for approval, deduped per entity.
        if (p.entityId && (await hasPendingSuggestion(user.id, p.entityId))) continue;
        await recordActivity({
          userId: user.id,
          persona,
          kind: `${def.type}_suggested`,
          title: p.title,
          entityType: p.entityType,
          entityId: p.entityId,
          status: "suggested",
          payload: { persona, tool: p.tool, args: p.args },
        });
        summary.suggested++;
      }
    }
    summary.acted += acted;
    summary.ran.push(def.type);
    await touchLastRun(user.id, persona, def.type);
  }

  if (summary.suggested > 0) {
    await sendPushNotification({
      userId: user.id,
      title: "Your AI agent has suggestions",
      body: `${summary.suggested} action${summary.suggested === 1 ? "" : "s"} awaiting your approval.`,
      actions: [],
    }).catch(() => {});
  }
  return summary;
}

/** Global tick (QStash schedule): run for every user×persona with active automations. */
export async function runDueProfessionalAutomations(): Promise<{ runs: number }> {
  const res = await query<{ user_id: string; persona: string }>(
    `SELECT DISTINCT user_id, persona FROM professional_automations
      WHERE enabled = true AND autonomy <> 'off'`,
  );
  let runs = 0;
  for (const row of res.rows) {
    const user = await loadUser(row.user_id);
    if (!user) continue;
    try {
      await runProfessionalAutomationsForUser(user, row.persona);
      runs++;
    } catch (err) {
      console.error(`[proAutomationRunner] ${row.user_id}/${row.persona} failed:`, err);
    }
  }
  return { runs };
}

/** Approve a suggested activity item → run its stored tool via the vertical. */
export async function approveProfessionalSuggestion(
  user: AppUser,
  activityId: string,
): Promise<{ ok: boolean; message: string }> {
  const activity = await getActivity(user.id, activityId);
  if (!activity) return { ok: false, message: "not_found" };
  if (activity.status !== "suggested") return { ok: false, message: "not_pending" };

  const persona = String(activity.payload.persona ?? "");
  const tool = String(activity.payload.tool ?? "");
  const args = (activity.payload.args as Record<string, unknown>) ?? {};
  const vertical = getVertical(persona);
  if (!vertical || !tool) {
    await setActivityStatus(user.id, activityId, "failed");
    return { ok: false, message: "unsupported" };
  }
  try {
    const res = await vertical.executeTool(user, tool, args);
    await setActivityStatus(user.id, activityId, res.ok ? "done" : "failed");
    return res;
  } catch (err) {
    await setActivityStatus(user.id, activityId, "failed");
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
