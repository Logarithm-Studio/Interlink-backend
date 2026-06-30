/**
 * Autonomy engine (Professional Mode, iter3).
 *
 * Evaluates each user's automations and acts per autonomy level + guardrails,
 * writing everything to the agent activity feed:
 *   - Auto    → performs the action (guardrail-checked).
 *   - Suggest → creates a `suggested` activity item (+ push) for one-tap approval.
 *   - Off     → skipped.
 *
 * Reuses the existing services as the agent's "hands": dunning / expenses / reporting.
 */

import { query } from "../../config/db";
import { AppUser } from "../../types";
import { sendPushNotification } from "../notifications/push.service";
import {
  getAutomations,
  type Automation,
  type AutomationType,
} from "./automations.service";
import { capEscalation, checkDunningGuardrails } from "./guardrails";
import {
  hasPendingSuggestion,
  recordActivity,
  setActivityStatus,
  getActivity,
} from "./activity.service";
import { listInvoices, type Invoice } from "./invoices.service";
import { sendInvoiceReminder } from "./dunning.service";
import { runExpenseAudit } from "./expenses.service";
import { emailFlashReport } from "./reporting.service";

const DAY_MS = 86_400_000;
const TONES = ["friendly", "firm", "final"] as const;

async function loadUser(userId: string): Promise<AppUser | null> {
  const res = await query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  return res.rows[0] ? { id: res.rows[0].id, email: res.rows[0].email } : null;
}

function dunningDue(inv: Invoice, cadenceDays: number): boolean {
  if (inv.reminderCount >= 3) return false; // already at final notice
  if (inv.status === "overdue") return true; // never reminded
  if (inv.status === "reminded" && inv.lastReminderAt) {
    return Date.now() - new Date(inv.lastReminderAt).getTime() >= cadenceDays * DAY_MS;
  }
  return false;
}

function isDue(automation: Automation, everyDays: number): boolean {
  if (!automation.lastRunAt) return true;
  return Date.now() - new Date(automation.lastRunAt).getTime() >= everyDays * DAY_MS;
}

async function touchLastRun(userId: string, type: AutomationType): Promise<void> {
  await query(
    `UPDATE accountant_automations SET last_run_at = now(), updated_at = now()
      WHERE user_id = $1 AND type = $2`,
    [userId, type],
  );
}

// ─── Per-automation handlers ──────────────────────────────────────────────────

async function runDunning(user: AppUser, automation: Automation): Promise<void> {
  const cadence = (automation.config.cadenceDays as number) ?? 5;
  const invoices = (await listInvoices(user.id)).filter((i) =>
    dunningDue(i, cadence),
  );

  for (const inv of invoices) {
    const tone = capEscalation(
      TONES[Math.min(inv.reminderCount, 2)],
      automation.guardrails,
    );

    if (automation.autonomy === "auto") {
      const decision = await checkDunningGuardrails({
        userId: user.id,
        automation,
        clientName: inv.clientName,
      });
      if (!decision.allowed) {
        if (decision.reason === "daily_cap_reached") break; // stop for today
        continue; // client paused / outside hours → skip this one
      }
      try {
        await sendInvoiceReminder({ user, invoiceId: inv.id, escalationTone: tone });
        await recordActivity({
          userId: user.id,
          kind: "reminder_sent",
          title: `Reminder sent to ${inv.clientName}`,
          detail: `${tone} tone · ${inv.invoiceNumber}`,
          entityType: "invoice",
          entityId: inv.id,
          status: "done",
        });
      } catch (err) {
        await recordActivity({
          userId: user.id,
          kind: "reminder_failed",
          title: `Reminder to ${inv.clientName} failed`,
          detail: err instanceof Error ? err.message : String(err),
          entityType: "invoice",
          entityId: inv.id,
          status: "failed",
        });
      }
    } else {
      // Suggest — queue for approval (dedupe per invoice).
      if (await hasPendingSuggestion(user.id, inv.id)) continue;
      await recordActivity({
        userId: user.id,
        kind: "reminder_suggested",
        title: `Send a ${tone} reminder to ${inv.clientName}?`,
        detail: inv.invoiceNumber,
        entityType: "invoice",
        entityId: inv.id,
        status: "suggested",
        payload: { invoiceId: inv.id, tone, clientName: inv.clientName },
      });
    }
  }
}

async function runAudit(user: AppUser, automation: Automation): Promise<void> {
  if (automation.autonomy === "auto") {
    const res = await runExpenseAudit(user.id);
    await recordActivity({
      userId: user.id,
      kind: "audit_run",
      title: `Expense audit flagged ${res.flaggedCount} item${res.flaggedCount === 1 ? "" : "s"}`,
      status: "done",
    });
  } else {
    await recordActivity({
      userId: user.id,
      kind: "audit_suggested",
      title: "Run an AI expense audit?",
      status: "suggested",
      payload: { action: "run_audit" },
    });
  }
}

async function runReport(user: AppUser, automation: Automation): Promise<void> {
  if (automation.autonomy === "auto") {
    await emailFlashReport(user);
    await recordActivity({
      userId: user.id,
      kind: "report_emailed",
      title: "Flash financial report emailed to you",
      status: "done",
    });
  } else {
    await recordActivity({
      userId: user.id,
      kind: "report_suggested",
      title: "Email yourself this week's flash report?",
      status: "suggested",
      payload: { action: "email_report" },
    });
  }
}

// ─── Public ──────────────────────────────────────────────────────────────────

export interface RunSummary {
  ran: AutomationType[];
  suggested: number;
  acted: number;
}

/** Run all due automations for one user. Returns a small summary. */
export async function runAutomationsForUser(user: AppUser): Promise<RunSummary> {
  const automations = await getAutomations(user.id);
  const ran: AutomationType[] = [];

  for (const a of automations) {
    if (!a.enabled || a.autonomy === "off") continue;

    if (a.type === "dunning_sequence") {
      await runDunning(user, a);
      ran.push(a.type);
      await touchLastRun(user.id, a.type);
    } else if (a.type === "expense_audit" && isDue(a, (a.config.everyDays as number) ?? 7)) {
      await runAudit(user, a);
      ran.push(a.type);
      await touchLastRun(user.id, a.type);
    } else if (a.type === "flash_report" && isDue(a, 7)) {
      await runReport(user, a);
      ran.push(a.type);
      await touchLastRun(user.id, a.type);
    }
    // tax_docs handled in its own flow (Phase 5); skipped here.
  }

  return { ran, suggested: 0, acted: 0 };
}

/** Global tick (QStash schedule): run for every user with enabled automations. */
export async function runDueAutomations(): Promise<{ users: number }> {
  const res = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM accountant_automations
      WHERE enabled = true AND autonomy <> 'off'`,
  );
  let count = 0;
  for (const row of res.rows) {
    const user = await loadUser(row.user_id);
    if (!user) continue;
    try {
      await runAutomationsForUser(user);
      count++;
    } catch (err) {
      console.error(`[automationRunner] user ${row.user_id} failed:`, err);
    }
  }
  return { users: count };
}

// ─── Approve a suggested activity item ────────────────────────────────────────

export async function approveSuggestedActivity(
  user: AppUser,
  activityId: string,
): Promise<{ ok: boolean; detail: string }> {
  const activity = await getActivity(user.id, activityId);
  if (!activity) return { ok: false, detail: "not_found" };
  if (activity.status !== "suggested") return { ok: false, detail: "not_pending" };

  try {
    if (activity.kind === "reminder_suggested") {
      const invoiceId = String(activity.payload.invoiceId ?? activity.entityId ?? "");
      const tone = activity.payload.tone as "friendly" | "firm" | "final" | undefined;
      await sendInvoiceReminder({ user, invoiceId, escalationTone: tone });
      await recordActivity({
        userId: user.id,
        kind: "reminder_sent",
        title: `Reminder sent to ${activity.payload.clientName ?? "client"}`,
        entityType: "invoice",
        entityId: invoiceId,
        status: "done",
      });
    } else if (activity.kind === "audit_suggested") {
      await runExpenseAudit(user.id);
    } else if (activity.kind === "report_suggested") {
      await emailFlashReport(user);
    } else {
      return { ok: false, detail: "unsupported" };
    }
    await setActivityStatus(user.id, activityId, "done");
    return { ok: true, detail: "executed" };
  } catch (err) {
    await setActivityStatus(user.id, activityId, "failed");
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
