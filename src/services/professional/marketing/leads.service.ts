import { query } from "../../../config/db";
import { AppError, NotFoundError } from "../../../utils/errors";
import type { MarketingLeadStatus } from "../sales/sales.service";
import { createTask as createTodoistTask, getCompletedTasks as getTodoistCompletedTasks, getTasks as getTodoistTasks, type TodoistTask } from "../../todoist/todoist.service";
import { getMarketingTodoistProjectId } from "./todoist-project.service";
import { enqueueJob } from "../../jobQueue.service";
import { markResolvedBySource, upsertItem, HUB_WEIGHTS } from "../../notifications/hub.service";
import { resolveGoogleAccount } from "../../auth.service";
import { AuthError, computeDraftIdempotencyKey, createGmailDraft, sendGmailDraft } from "../../email/gmail.service";
import { sendPushNotification } from "../../notifications/push.service";
import { canRetryMarketingReminderDelivery, marketingReminderDeliveryKey, type MarketingReminderChannel, type MarketingReminderDeliveryStatus } from "./reminder-delivery.model";

export interface MarketingLead {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  title: string | null;
  source: string;
  campaignId: string | null;
  campaignTopic: string | null;
  attribution: Record<string, string>;
  status: MarketingLeadStatus;
  marketingOptIn: boolean;
  assignedRepId: string | null;
  assignedRepName: string | null;
  createdAt: Date;
  score: number;
  scoreReasons: string[];
}

export interface MarketingFollowup {
  id: string;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  company: string | null;
  campaignId: string | null;
  campaignTopic: string | null;
  title: string;
  dueAt: Date;
  reminderAt: Date | null;
  reminderAddedAt: Date | null;
  reminderDeliveries: Partial<Record<MarketingReminderChannel, MarketingReminderDeliveryStatus>>;
  status: "open" | "completed" | "cancelled";
  notes: string | null;
  completedAt: Date | null;
  createdAt: Date;
  todoistTaskId: string | null;
  todoistSyncedAt: Date | null;
  assignedRepId: string | null;
  assignedRepName: string | null;
}

export interface MarketingReminderPreferences {
  pushEnabled: boolean;
  emailEnabled: boolean;
  pushAvailable: boolean;
  emailAvailable: boolean;
  emailAddress: string | null;
  updatedAt: Date | null;
}

export interface MarketingFollowupTodoistExport { taskId: string; created: boolean }
export interface MarketingFollowupTodoistSync {
  taskId: string | null;
  linked: boolean;
  found: boolean;
  active: boolean;
  completed: boolean;
}

const TODOIST_HISTORY_DAYS = 89;

function marketingReminderDedupKey(followupId: string, reminderAt: Date): string {
  return `internal:marketing-followup:${followupId}:reminder:${reminderAt.getTime()}`;
}

async function resolveMarketingReminder(userId: string, followupId: string, reminderAt: Date | null): Promise<void> {
  if (reminderAt) await markResolvedBySource(userId, marketingReminderDedupKey(followupId, reminderAt));
}

const DUE_MARKETING_REMINDER_FILTER = `f.status='open' AND f.reminder_at IS NOT NULL AND f.reminder_at<=now()
  AND (f.reminder_added_at IS NULL OR
    EXISTS (SELECT 1 FROM sales_marketing_followup_reminder_preferences p
      WHERE p.user_id=f.user_id AND p.push_enabled AND NOT EXISTS (
        SELECT 1 FROM sales_marketing_followup_reminder_deliveries d
         WHERE d.followup_id=f.id AND d.reminder_at=f.reminder_at AND d.channel='push')) OR
    EXISTS (SELECT 1 FROM sales_marketing_followup_reminder_preferences p
      JOIN sales_marketing_followup_reminder_deliveries d
        ON d.user_id=p.user_id AND d.followup_id=f.id AND d.reminder_at=f.reminder_at
       WHERE p.user_id=f.user_id AND p.push_enabled AND d.channel='push' AND d.status='pending') OR
    EXISTS (SELECT 1 FROM sales_marketing_followup_reminder_preferences p
      WHERE p.user_id=f.user_id AND p.email_enabled AND NOT EXISTS (
        SELECT 1 FROM sales_marketing_followup_reminder_deliveries d
         WHERE d.followup_id=f.id AND d.reminder_at=f.reminder_at AND d.channel='email')) OR
    EXISTS (SELECT 1 FROM sales_marketing_followup_reminder_preferences p
      JOIN sales_marketing_followup_reminder_deliveries d
        ON d.user_id=p.user_id AND d.followup_id=f.id AND d.reminder_at=f.reminder_at
       WHERE p.user_id=f.user_id AND p.email_enabled AND d.channel='email' AND d.status='pending')) `;

async function readMarketingReminderPreferences(userId: string): Promise<MarketingReminderPreferences> {
  const [preferenceResult, account, pushResult] = await Promise.all([
    query<{ push_enabled: boolean; email_enabled: boolean; updated_at: Date }>(
      `SELECT push_enabled,email_enabled,updated_at
         FROM sales_marketing_followup_reminder_preferences WHERE user_id=$1`, [userId],
    ),
    resolveGoogleAccount(userId, "professional"),
    query<{ available: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM push_tokens WHERE user_id=$1) AS available`, [userId],
    ),
  ]);
  const row = preferenceResult.rows[0];
  const emailAvailable = Boolean(account?.email && !account.reauthRequired);
  const pushAvailable = Boolean(pushResult.rows[0]?.available
    && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  return {
    pushEnabled: row?.push_enabled ?? false,
    emailEnabled: row?.email_enabled ?? false,
    pushAvailable,
    emailAvailable,
    emailAddress: emailAvailable ? account?.email ?? null : null,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function getMarketingReminderPreferences(userId: string): Promise<MarketingReminderPreferences> {
  return readMarketingReminderPreferences(userId);
}

export async function saveMarketingReminderPreferences(
  userId: string,
  input: { pushEnabled: boolean; emailEnabled: boolean },
): Promise<MarketingReminderPreferences> {
  const current = await readMarketingReminderPreferences(userId);
  if (input.pushEnabled && !current.pushAvailable) {
    throw new AppError("Register a push-enabled device and ensure push delivery is configured before enabling push reminders.", 409);
  }
  if (input.emailEnabled && !current.emailAvailable) {
    throw new AppError("Connect an available Google account before enabling email reminders.", 409);
  }
  await query(
    `INSERT INTO sales_marketing_followup_reminder_preferences(user_id,push_enabled,email_enabled,updated_at)
       VALUES($1,$2,$3,now())
     ON CONFLICT(user_id) DO UPDATE SET push_enabled=EXCLUDED.push_enabled,
       email_enabled=EXCLUDED.email_enabled,updated_at=now()`,
    [userId, input.pushEnabled, input.emailEnabled],
  );
  return readMarketingReminderPreferences(userId);
}

interface DueMarketingReminder {
  id: string;
  user_id: string;
  contact_id: string;
  contact_name: string;
  company: string | null;
  campaign_id: string | null;
  campaign_topic: string | null;
  title: string;
  due_at: Date;
  reminder_at: Date;
  reminder_added_at: Date | null;
}

async function finishMarketingReminderDelivery(
  deliveryId: string,
  status: Exclude<MarketingReminderDeliveryStatus, "sending" | "pending">,
  errorCode: string | null = null,
  providerMessageId: string | null = null,
): Promise<void> {
  await query(
    `UPDATE sales_marketing_followup_reminder_deliveries
        SET status=$2,error_code=$3,provider_message_id=$4,updated_at=now()
      WHERE id=$1 AND status='sending'`,
    [deliveryId, status, errorCode, providerMessageId?.slice(0, 512) ?? null],
  );
}

async function claimMarketingReminderDelivery(
  userId: string,
  followupId: string,
  reminderAt: Date,
  channel: MarketingReminderChannel,
): Promise<string | null> {
  const result = await query<{ id: string }>(
    `WITH retry_claim AS (
       UPDATE sales_marketing_followup_reminder_deliveries
          SET status='sending',error_code=NULL,provider_message_id=NULL,attempted_at=now(),updated_at=now()
        WHERE user_id=$1 AND followup_id=$2 AND reminder_at=$3 AND channel=$4 AND status='pending'
          AND EXISTS (SELECT 1 FROM sales_marketing_followups f
            WHERE f.id=$2 AND f.user_id=$1 AND f.status='open' AND f.reminder_at=$3)
          AND EXISTS (SELECT 1 FROM sales_marketing_followup_reminder_preferences p
            WHERE p.user_id=$1 AND (($4='push' AND p.push_enabled) OR ($4='email' AND p.email_enabled)))
        RETURNING id
     ), fresh_claim AS (
       INSERT INTO sales_marketing_followup_reminder_deliveries
         (user_id,followup_id,reminder_at,channel,status)
       SELECT $1,$2,$3,$4,'sending'
        WHERE EXISTS (SELECT 1 FROM sales_marketing_followups f
          WHERE f.id=$2 AND f.user_id=$1 AND f.status='open' AND f.reminder_at=$3)
          AND EXISTS (SELECT 1 FROM sales_marketing_followup_reminder_preferences p
            WHERE p.user_id=$1 AND (($4='push' AND p.push_enabled) OR ($4='email' AND p.email_enabled)))
       ON CONFLICT(followup_id,reminder_at,channel) DO NOTHING
       RETURNING id
     )
     SELECT id FROM retry_claim UNION ALL SELECT id FROM fresh_claim LIMIT 1`,
    [userId, followupId, reminderAt, channel],
  );
  return result.rows[0]?.id ?? null;
}

export async function requestMarketingReminderDeliveryRetry(
  userId: string,
  followupId: string,
  channel: MarketingReminderChannel,
  confirmedNotSent = false,
): Promise<void> {
  const existing = await query<{ id: string; reminder_at: Date; status: MarketingReminderDeliveryStatus }>(
    `SELECT d.id,d.reminder_at,d.status
       FROM sales_marketing_followup_reminder_deliveries d
       JOIN sales_marketing_followups f ON f.id=d.followup_id AND f.user_id=d.user_id
      WHERE d.user_id=$1 AND d.followup_id=$2 AND d.channel=$3
        AND f.status='open' AND f.reminder_at=d.reminder_at AND f.reminder_at<=now()`,
    [userId, followupId, channel],
  );
  const delivery = existing.rows[0];
  if (!delivery) throw new NotFoundError("Marketing reminder delivery");
  if (!canRetryMarketingReminderDelivery(delivery.status, confirmedNotSent)) {
    throw new AppError("A confirmed failed delivery can be retried directly. For an uncertain send, check the provider and confirm it was not delivered.", 409);
  }

  const preferences = await readMarketingReminderPreferences(userId);
  const enabled = channel === "push" ? preferences.pushEnabled : preferences.emailEnabled;
  const available = channel === "push" ? preferences.pushAvailable : preferences.emailAvailable;
  if (!enabled || !available) throw new AppError("Enable and reconnect this reminder channel before retrying it.", 409);

  const updated = await query<{ id: string; attempted_at: Date }>(
    `UPDATE sales_marketing_followup_reminder_deliveries SET status='pending',error_code=NULL,
        attempted_at=now(),updated_at=now()
      WHERE id=$1 AND user_id=$2 AND status='failed'
      RETURNING id,attempted_at`, [delivery.id, userId],
  );
  if (!updated.rows[0]) throw new AppError("This reminder delivery has already changed.", 409);
  const idempotencyKey = `marketing-followup-reminder-retry:${delivery.id}:${new Date(updated.rows[0].attempted_at).getTime()}`;
  try {
    await enqueueJob("marketing-followup-reminder", {
      jobType: "marketing.followup.reminder",
      idempotencyKey,
      userId,
      payload: {},
    }, { jobId: idempotencyKey, retries: 3 });
  } catch {
    await query(
      `UPDATE sales_marketing_followup_reminder_deliveries
          SET status='failed',error_code='retry_schedule_failed',updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status='pending'`, [delivery.id, userId],
    );
    throw new AppError("The retry could not be scheduled. The failed delivery is still recorded.", 503);
  }
}

async function deliverMarketingReminderPush(userId: string, reminder: DueMarketingReminder): Promise<void> {
  const deliveryId = await claimMarketingReminderDelivery(userId, reminder.id, reminder.reminder_at, "push");
  if (!deliveryId) return;
  try {
    const result = await sendPushNotification({
      userId,
      title: `Marketing follow-up due: ${reminder.contact_name}`,
      body: reminder.title,
      actions: [],
      data: { type: "marketing_followup_reminder", followupId: reminder.id },
    });
    if (result.sent) {
      await finishMarketingReminderDelivery(deliveryId, "sent", null, result.messageId ?? null);
    } else if (result.reason === "fcm_error") {
      await finishMarketingReminderDelivery(deliveryId, "review", "push_delivery_uncertain");
    } else {
      await finishMarketingReminderDelivery(deliveryId, "failed", result.reason === "no_token" ? "push_no_device" : "push_not_configured");
    }
  } catch {
    await finishMarketingReminderDelivery(deliveryId, "review", "push_delivery_uncertain");
  }
}

async function deliverMarketingReminderEmail(
  userId: string,
  reminder: DueMarketingReminder,
  accountId: string | null,
  accountEmail: string | null,
): Promise<void> {
  const deliveryId = await claimMarketingReminderDelivery(userId, reminder.id, reminder.reminder_at, "email");
  if (!deliveryId) return;
  if (!accountId || !accountEmail) {
    await finishMarketingReminderDelivery(deliveryId, "failed", "email_account_unavailable");
    return;
  }

  const deliveryKey = marketingReminderDeliveryKey(reminder.id, new Date(reminder.reminder_at), "email");
  const executionId = deliveryKey;
  const stepId = "followup-reminder-email";
  const subject = `Marketing follow-up due: ${reminder.contact_name}`;
  const body = [
    `Your follow-up task is due ${new Date(reminder.due_at).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}.`,
    "",
    `Contact: ${reminder.contact_name}${reminder.company ? ` (${reminder.company})` : ""}`,
    reminder.campaign_topic ? `Campaign: ${reminder.campaign_topic}` : null,
    `Task: ${reminder.title}`,
    "",
    "Open Interlink Marketing Follow-ups to update the task.",
  ].filter((line): line is string => line !== null).join("\n");
  const idempotencyKey = computeDraftIdempotencyKey(executionId, stepId, [accountEmail], subject);
  let draft;
  try {
    draft = await createGmailDraft({
      executionId: null,
      stepId,
      userId,
      googleAccountId: accountId,
      fromEmail: accountEmail,
      recipients: [accountEmail],
      subject,
      body,
      idempotencyKey,
    });
    if (!draft.providerDraftId) {
      await finishMarketingReminderDelivery(deliveryId, "review", "email_draft_id_unavailable");
      return;
    }
  } catch (error) {
    await finishMarketingReminderDelivery(deliveryId,
      error instanceof AuthError ? "failed" : "review",
      error instanceof AuthError ? "email_reconnect_required" : "email_draft_creation_uncertain",
    );
    return;
  }

  try {
    const sent = await sendGmailDraft({
      executionId,
      stepId,
      userId,
      googleAccountId: accountId,
      providerDraftId: draft.providerDraftId,
      idempotencyKey: `marketing-reminder-send:${idempotencyKey}`,
    });
    await finishMarketingReminderDelivery(deliveryId, "sent", null, sent.messageId || null);
  } catch (error) {
    await finishMarketingReminderDelivery(deliveryId,
      error instanceof AuthError ? "failed" : "review",
      error instanceof AuthError ? "email_reconnect_required" : "email_send_uncertain",
    );
  }
}

/** Queue due reminders per user so provider calls stay isolated and bounded. */
export async function dispatchMarketingFollowupReminderUsers(): Promise<number> {
  const result = await query<{ user_id: string }>(
    `WITH due_users AS (
       SELECT f.user_id,MIN(f.reminder_at) AS scheduled_at
         FROM sales_marketing_followups f
        WHERE ${DUE_MARKETING_REMINDER_FILTER}
        GROUP BY f.user_id
     ), interrupted_users AS (
       SELECT user_id,MIN(updated_at) AS scheduled_at
         FROM sales_marketing_followup_reminder_deliveries
        WHERE status='sending' AND updated_at < now() - interval '15 minutes'
        GROUP BY user_id
     ), eligible_users AS (
       SELECT user_id,scheduled_at FROM due_users
       UNION ALL
       SELECT user_id,scheduled_at FROM interrupted_users
     )
     SELECT user_id FROM eligible_users
      GROUP BY user_id ORDER BY MIN(scheduled_at) ASC LIMIT 50`,
  );
  const hour = new Date().toISOString().slice(0, 13);
  for (const row of result.rows) {
    const idempotencyKey = `marketing-followup-reminders:${row.user_id}:${hour}`;
    await enqueueJob("marketing-followup-reminder", {
      jobType: "marketing.followup.reminder",
      idempotencyKey,
      userId: row.user_id,
      payload: {},
    }, { jobId: idempotencyKey, retries: 3 });
  }
  return result.rows.length;
}

/** Add due reminders to the Hub and send the marketer's opted-in channels once each. */
export async function dispatchDueMarketingFollowupRemindersForUser(userId: string): Promise<number> {
  await query(
    `UPDATE sales_marketing_followup_reminder_deliveries
        SET status='review',error_code='delivery_interrupted',updated_at=now()
      WHERE user_id=$1 AND status='sending' AND updated_at < now() - interval '15 minutes'`, [userId],
  );
  const result = await query<DueMarketingReminder>(
    `SELECT f.id,f.user_id,f.contact_id,c.name AS contact_name,c.company,f.campaign_id,
       mc.topic AS campaign_topic,f.title,f.due_at,f.reminder_at,f.reminder_added_at
       FROM sales_marketing_followups f
       JOIN sales_contacts c ON c.id=f.contact_id AND c.user_id=f.user_id
       LEFT JOIN sales_marketing_campaigns mc ON mc.id=f.campaign_id AND mc.user_id=f.user_id
      WHERE f.user_id=$1 AND ${DUE_MARKETING_REMINDER_FILTER}
      ORDER BY f.reminder_at ASC LIMIT 10`, [userId],
  );
  if (!result.rows.length) return 0;

  const preferences = await readMarketingReminderPreferences(userId);
  const account = preferences.emailEnabled ? await resolveGoogleAccount(userId, "professional") : null;
  for (const row of result.rows) {
    const reminderAt = new Date(row.reminder_at);
    const dedupKey = marketingReminderDedupKey(row.id, reminderAt);
    if (!row.reminder_added_at) {
      await upsertItem({
        userId: row.user_id, mode: "professional", source: "internal", kind: "marketing_followup_reminder",
        dedupKey,
        title: `Follow up with ${row.contact_name}: ${row.title}`,
        preview: [row.company, row.campaign_topic ? `Campaign: ${row.campaign_topic}` : null]
          .filter(Boolean).join(" · ") || null,
        actor: row.campaign_topic,
        weight: HUB_WEIGHTS.lead,
        externalRef: { route: "/(work)/marketing-followups", followupId: row.id, contactId: row.contact_id, campaignId: row.campaign_id },
        occurredAt: reminderAt,
      });
      const marked = await query(
        `UPDATE sales_marketing_followups SET reminder_added_at=COALESCE(reminder_added_at,now()),
            updated_at=CASE WHEN reminder_added_at IS NULL THEN now() ELSE updated_at END
          WHERE id=$1 AND user_id=$2 AND status='open' AND reminder_at=$3
          RETURNING id`, [row.id, row.user_id, row.reminder_at],
      );
      if (!marked.rows[0]) {
        await markResolvedBySource(row.user_id, dedupKey);
        continue;
      }
    }
    if (preferences.pushEnabled) await deliverMarketingReminderPush(userId, row);
    if (preferences.emailEnabled) {
      await deliverMarketingReminderEmail(userId, row, account?.id ?? null, account?.email ?? null);
    }
  }
  return result.rows.length;
}

export function marketingFollowupTodoistMarker(followupId: string): string {
  return `Interlink marketing follow-up: ${followupId}`;
}

export function findMarketingFollowupTodoistTask(tasks: TodoistTask[], marker: string): TodoistTask | undefined {
  return tasks.find((task) => task.description.split(/\r?\n/).some((line) => line.trim() === marker));
}

export function todoistMarketingCompletionWindow(now = new Date()): { since: Date; until: Date } {
  return { since: new Date(now.getTime() - TODOIST_HISTORY_DAYS * 86_400_000), until: now };
}

export interface LinkedMarketingTodoistTask { followupId: string; taskId: string }
export interface MarketingTodoistTaskResolution extends LinkedMarketingTodoistTask { state: "active" | "completed" | "missing" }

export function resolveMarketingTodoistTasks(
  followups: LinkedMarketingTodoistTask[],
  activeTasks: TodoistTask[],
  completedTasks: TodoistTask[],
): MarketingTodoistTaskResolution[] {
  const activeIds = new Set(activeTasks.map((task) => task.id));
  const completedIds = new Set(completedTasks.map((task) => task.id));
  return followups.map((followup) => ({
    ...followup,
    state: activeIds.has(followup.taskId) ? "active" : completedIds.has(followup.taskId) ? "completed" : "missing",
  }));
}

/** Queue due, mapped follow-up accounts for a QStash worker; provider calls fan out per user. */
export async function dispatchStaleMarketingTodoistSyncs(): Promise<number> {
  const result = await query<{ user_id: string }>(
    `SELECT f.user_id
       FROM sales_marketing_followups f
       JOIN connected_integrations ci ON ci.user_id=f.user_id AND ci.provider='todoist' AND ci.status='active'
      WHERE f.status='open' AND f.todoist_task_id IS NOT NULL
        AND (f.todoist_synced_at IS NULL OR f.todoist_synced_at < now() - interval '55 minutes')
      GROUP BY f.user_id
      ORDER BY MIN(f.todoist_synced_at) ASC NULLS FIRST
      LIMIT 50`,
  );
  const hour = new Date().toISOString().slice(0, 13);
  for (const row of result.rows) {
    const idempotencyKey = `marketing-todoist-sync:${row.user_id}:${hour}`;
    await enqueueJob("marketing-todoist-sync", {
      jobType: "marketing.todoist.sync",
      idempotencyKey,
      userId: row.user_id,
      payload: {},
    }, { jobId: idempotencyKey, retries: 3 });
  }
  return result.rows.length;
}

const todoistExports = new Map<string, Promise<MarketingFollowupTodoistExport>>();

/** Add a one-time, deduplicated copy of an open marketing follow-up to Todoist. */
export async function exportMarketingFollowupToTodoist(userId: string, followupId: string): Promise<MarketingFollowupTodoistExport> {
  const key = `${userId}:${followupId}`;
  const pending = todoistExports.get(key);
  if (pending) return pending;

  const operation = (async () => {
    const result = await query(
      `SELECT f.id,f.campaign_id,f.title,f.due_at,f.notes,f.status,f.todoist_task_id,c.name AS contact_name,c.company,mc.topic AS campaign_topic
         FROM sales_marketing_followups f
         JOIN sales_contacts c ON c.id=f.contact_id AND c.user_id=f.user_id
         LEFT JOIN sales_marketing_campaigns mc ON mc.id=f.campaign_id AND mc.user_id=f.user_id
        WHERE f.id=$1 AND f.user_id=$2`, [followupId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError("Marketing follow-up");
    if (row.status !== "open") throw new AppError("Only open marketing follow-ups can be copied to Todoist.", 409);
    if (typeof row.todoist_task_id === "string" && row.todoist_task_id) {
      return { taskId: row.todoist_task_id, created: false };
    }

    const marker = marketingFollowupTodoistMarker(followupId);
    const activeTasks = await getTodoistTasks(userId);
    const existing = findMarketingFollowupTodoistTask(activeTasks, marker);
    if (existing) {
      await persistTodoistTaskLink(userId, followupId, existing.id, false, false);
      return { taskId: existing.id, created: false };
    }

    const completionWindow = todoistMarketingCompletionWindow();
    const completedTask = findMarketingFollowupTodoistTask(
      await getTodoistCompletedTasks(userId, completionWindow.since, completionWindow.until), marker,
    );
    if (completedTask) {
      await persistTodoistTaskLink(userId, followupId, completedTask.id, false, false);
      return { taskId: completedTask.id, created: false };
    }

    const description = [
      `Contact: ${row.contact_name}${row.company ? ` at ${row.company}` : ""}`,
      row.campaign_topic ? `Campaign: ${row.campaign_topic}` : null,
      typeof row.notes === "string" && row.notes.trim() ? `Notes: ${row.notes.trim()}` : null,
      marker,
    ].filter(Boolean).join("\n\n");
    const projectId = await getMarketingTodoistProjectId(userId, typeof row.campaign_id === "string" ? row.campaign_id : null);
    const task = await createTodoistTask(userId, {
      content: String(row.title), description, dueDatetime: new Date(row.due_at).toISOString(), priority: 2,
      ...(projectId ? { projectId } : {}),
    });
    await persistTodoistTaskLink(userId, followupId, task.id, false, false);
    return { taskId: task.id, created: true };
  })();

  todoistExports.set(key, operation);
  try {
    return await operation;
  } finally {
    if (todoistExports.get(key) === operation) todoistExports.delete(key);
  }
}

async function persistTodoistTaskLink(
  userId: string,
  followupId: string,
  taskId: string,
  completed = false,
  checked = true,
): Promise<void> {
  const result = await query<{ reminder_at: Date | null }>(
    `UPDATE sales_marketing_followups
        SET todoist_task_id=COALESCE(todoist_task_id,$3),
            todoist_synced_at=CASE WHEN $5 THEN now() ELSE todoist_synced_at END,
            status=CASE WHEN $4 AND status='open' THEN 'completed' ELSE status END,
            completed_at=CASE WHEN $4 AND status='open' THEN now() ELSE completed_at END,
            updated_at=now()
      WHERE id=$1 AND user_id=$2 AND (todoist_task_id IS NULL OR todoist_task_id=$3)
      RETURNING reminder_at`,
    [followupId, userId, taskId, completed, checked],
  );
  if (completed) await resolveMarketingReminder(userId, followupId, result.rows[0]?.reminder_at ?? null);
}

/** Check one linked task in Todoist, linking older copies by their stable marker when possible. */
export async function syncMarketingFollowupFromTodoist(userId: string, followupId: string): Promise<MarketingFollowupTodoistSync> {
  const result = await query(
    `SELECT id,status,created_at,todoist_task_id FROM sales_marketing_followups WHERE id=$1 AND user_id=$2`,
    [followupId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Marketing follow-up");
  if (row.status !== "open") throw new AppError("Only open follow-ups can be checked against Todoist.", 409);

  const taskId = typeof row.todoist_task_id === "string" && row.todoist_task_id ? row.todoist_task_id : null;
  const marker = marketingFollowupTodoistMarker(followupId);
  const activeTasks = await getTodoistTasks(userId);
  const activeTask = taskId
    ? activeTasks.find((task) => task.id === taskId)
    : findMarketingFollowupTodoistTask(activeTasks, marker);
  if (activeTask) {
    await persistTodoistTaskLink(userId, followupId, activeTask.id);
    return { taskId: activeTask.id, linked: true, found: true, active: true, completed: false };
  }

  const historyWindow = todoistMarketingCompletionWindow();
  const completedTasks = await getTodoistCompletedTasks(userId, historyWindow.since, historyWindow.until);
  const completedTask = taskId
    ? completedTasks.find((task) => task.id === taskId)
    : findMarketingFollowupTodoistTask(completedTasks, marker);

  if (!completedTask) {
    if (taskId) await query(
      `UPDATE sales_marketing_followups SET todoist_synced_at=now(),updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status='open' AND todoist_task_id=$3`, [followupId, userId, taskId],
    );
    return { taskId, linked: Boolean(taskId), found: false, active: false, completed: false };
  }

  await persistTodoistTaskLink(userId, followupId, completedTask.id, true);
  return { taskId: completedTask.id, linked: true, found: true, active: false, completed: true };
}

/** Reconcile every open, linked marketing follow-up for a Todoist account with one provider read per state. */
export async function syncMarketingTodoistFollowupsForUser(userId: string): Promise<{ checked: number; completed: number; missing: number }> {
  const result = await query<{ id: string; todoist_task_id: string }>(
    `SELECT id,todoist_task_id FROM sales_marketing_followups
      WHERE user_id=$1 AND status='open' AND todoist_task_id IS NOT NULL
      ORDER BY todoist_synced_at ASC NULLS FIRST LIMIT 1000`, [userId],
  );
  if (!result.rows.length) return { checked: 0, completed: 0, missing: 0 };

  const followups = result.rows.map((row) => ({ followupId: row.id, taskId: row.todoist_task_id }));
  const activeTasks = await getTodoistTasks(userId);
  const activeIds = new Set(activeTasks.map((task) => task.id));
  const historyWindow = todoistMarketingCompletionWindow();
  const completedTasks = followups.some((followup) => !activeIds.has(followup.taskId))
    ? await getTodoistCompletedTasks(userId, historyWindow.since, historyWindow.until)
    : [];
  const resolutions = resolveMarketingTodoistTasks(followups, activeTasks, completedTasks);
  let completed = 0;
  let missing = 0;
  for (const resolution of resolutions) {
    if (resolution.state === "completed") {
      await persistTodoistTaskLink(userId, resolution.followupId, resolution.taskId, true);
      completed += 1;
    } else {
      if (resolution.state === "missing") missing += 1;
      await query(
        `UPDATE sales_marketing_followups SET todoist_synced_at=now(),updated_at=now()
          WHERE id=$1 AND user_id=$2 AND status='open' AND todoist_task_id=$3`,
        [resolution.followupId, userId, resolution.taskId],
      );
    }
  }
  return { checked: resolutions.length, completed, missing };
}

function scoreLead(row: Record<string, unknown>): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => { score += points; reasons.push(reason); };
  if (row.source === "inbound" || row.latest_source === "public_form") add(25, "Submitted an inbound form");
  else if (row.source === "email") add(20, "Lead was identified from email");
  if (row.campaign_id) add(20, "Linked to a campaign");
  if (row.email) add(15, "Email address is available");
  if (row.company) add(10, "Company is known");
  if (row.title) add(10, "Job title is known");
  const attribution = row.attribution && typeof row.attribution === "object" ? row.attribution as Record<string, unknown> : {};
  if (typeof attribution.utmSource === "string" && attribution.utmSource.trim()) add(10, "Source tracking is available");
  const capturedAt = row.captured_at instanceof Date ? row.captured_at : row.created_at instanceof Date ? row.created_at : null;
  const ageMs = capturedAt ? Date.now() - capturedAt.getTime() : Number.POSITIVE_INFINITY;
  if (ageMs <= 7 * 86_400_000) add(10, "Captured in the last 7 days");
  else if (ageMs <= 30 * 86_400_000) add(5, "Captured in the last 30 days");
  return { score: Math.min(100, score), reasons };
}

export async function listMarketingLeads(userId: string): Promise<MarketingLead[]> {
  const result = await query(
    `SELECT c.id,c.name,c.email,c.company,c.title,c.source,c.marketing_lead_status,c.marketing_opt_in,
        c.marketing_owner_rep_id,r.name AS marketing_owner_rep_name,
        c.created_at,latest.campaign_id,latest.attribution,latest.captured_at,latest.source AS latest_source,mc.topic AS campaign_topic
       FROM sales_contacts c
       LEFT JOIN sales_reps r ON r.id=c.marketing_owner_rep_id AND r.user_id=c.user_id
       LEFT JOIN LATERAL (
         SELECT contact_id,campaign_id,attribution,captured_at FROM sales_marketing_contact_attributions
          WHERE user_id=c.user_id AND contact_id=c.id ORDER BY captured_at DESC LIMIT 1
       ) latest ON true
       LEFT JOIN sales_marketing_campaigns mc ON mc.id=latest.campaign_id AND mc.user_id=c.user_id
      WHERE c.user_id=$1 AND (latest.contact_id IS NOT NULL OR c.source IN ('inbound','email') OR c.marketing_campaign_id IS NOT NULL)
      ORDER BY COALESCE(latest.captured_at,c.created_at) DESC LIMIT 300`,
    [userId],
  );
  return result.rows.map((row) => {
    const scored = scoreLead(row as Record<string, unknown>);
    return {
      id: row.id as string, name: row.name as string, email: row.email as string | null,
      company: row.company as string | null, title: row.title as string | null, source: row.source as string,
      campaignId: row.campaign_id as string | null, campaignTopic: row.campaign_topic as string | null,
      attribution: (row.attribution ?? {}) as Record<string, string>, status: row.marketing_lead_status as MarketingLeadStatus,
      marketingOptIn: row.marketing_opt_in as boolean, assignedRepId: row.marketing_owner_rep_id as string | null,
      assignedRepName: row.marketing_owner_rep_name as string | null,
      createdAt: (row.captured_at as Date | null) ?? (row.created_at as Date),
      score: scored.score, scoreReasons: scored.reasons,
    };
  });
}

export async function listMarketingFollowups(
  userId: string,
  status: MarketingFollowup["status"] = "open",
): Promise<MarketingFollowup[]> {
  const result = await query(
    `SELECT f.id,f.contact_id,c.name AS contact_name,c.email AS contact_email,c.company,
        c.marketing_owner_rep_id,r.name AS marketing_owner_rep_name,
        f.campaign_id,mc.topic AS campaign_topic,f.title,f.due_at,f.reminder_at,f.reminder_added_at,f.status,f.notes,f.completed_at,f.created_at,
        f.todoist_task_id,f.todoist_synced_at,
        (SELECT COALESCE(jsonb_object_agg(d.channel,d.status),'{}'::jsonb)
           FROM sales_marketing_followup_reminder_deliveries d
          WHERE d.user_id=f.user_id AND d.followup_id=f.id AND d.reminder_at=f.reminder_at) AS reminder_deliveries
       FROM sales_marketing_followups f
       JOIN sales_contacts c ON c.id=f.contact_id AND c.user_id=f.user_id
       LEFT JOIN sales_reps r ON r.id=c.marketing_owner_rep_id AND r.user_id=c.user_id
       LEFT JOIN sales_marketing_campaigns mc ON mc.id=f.campaign_id AND mc.user_id=f.user_id
      WHERE f.user_id=$1 AND f.status=$2 ORDER BY f.due_at ASC,f.created_at DESC LIMIT 300`,
    [userId, status],
  );
  return result.rows.map((row) => ({
    id: row.id as string, contactId: row.contact_id as string, contactName: row.contact_name as string,
    contactEmail: row.contact_email as string | null, company: row.company as string | null,
    campaignId: row.campaign_id as string | null, campaignTopic: row.campaign_topic as string | null,
    title: row.title as string, dueAt: row.due_at as Date, reminderAt: row.reminder_at as Date | null,
    reminderAddedAt: row.reminder_added_at as Date | null, status: row.status as MarketingFollowup["status"],
    reminderDeliveries: (row.reminder_deliveries ?? {}) as MarketingFollowup["reminderDeliveries"],
    notes: row.notes as string | null, completedAt: row.completed_at as Date | null, createdAt: row.created_at as Date,
    todoistTaskId: row.todoist_task_id as string | null, todoistSyncedAt: row.todoist_synced_at as Date | null,
    assignedRepId: row.marketing_owner_rep_id as string | null,
    assignedRepName: row.marketing_owner_rep_name as string | null,
  }));
}

export async function createMarketingFollowup(userId: string, input: {
  contactId: string; campaignId?: string; title: string; dueAt: Date; reminderAt?: Date | null; notes?: string;
}): Promise<MarketingFollowup> {
  const result = await query(
    `WITH valid_target AS (
       SELECT c.id AS contact_id,mc.id AS campaign_id
         FROM sales_contacts c
         LEFT JOIN sales_marketing_campaigns mc ON mc.id=$3 AND mc.user_id=$2
        WHERE c.id=$1 AND c.user_id=$2 AND ($3::uuid IS NULL OR mc.id IS NOT NULL)
     ), updated_contact AS (
       UPDATE sales_contacts SET marketing_lead_status=CASE WHEN marketing_lead_status IN ('new','qualified') THEN 'following_up' ELSE marketing_lead_status END,
         updated_at=now()
        WHERE id IN (SELECT contact_id FROM valid_target) RETURNING id
     )
     INSERT INTO sales_marketing_followups (user_id,contact_id,campaign_id,title,due_at,reminder_at,notes)
     SELECT $2,updated_contact.id,valid_target.campaign_id,$4,$5,$6,$7 FROM updated_contact
       JOIN valid_target ON valid_target.contact_id=updated_contact.id
     RETURNING id,contact_id,campaign_id,title,due_at,reminder_at,reminder_added_at,status,notes,completed_at,created_at,todoist_task_id,todoist_synced_at`,
    [input.contactId, userId, input.campaignId ?? null, input.title.trim(), input.dueAt, input.reminderAt ?? null, input.notes?.trim() || null],
  );
  if (!result.rows[0]) throw new NotFoundError("Contact or campaign");
  const contact = await query(
    `SELECT c.name,c.email,c.company,c.marketing_owner_rep_id,r.name AS marketing_owner_rep_name
       FROM sales_contacts c
       LEFT JOIN sales_reps r ON r.id=c.marketing_owner_rep_id AND r.user_id=c.user_id
      WHERE c.id=$1 AND c.user_id=$2`, [input.contactId, userId],
  );
  const campaign = input.campaignId
    ? await query(`SELECT topic FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`, [input.campaignId, userId])
    : null;
  const row = result.rows[0];
  return {
    id: row.id, contactId: row.contact_id, contactName: contact.rows[0].name,
    contactEmail: contact.rows[0].email, company: contact.rows[0].company,
    campaignId: row.campaign_id, campaignTopic: campaign?.rows[0]?.topic ?? null,
    title: row.title, dueAt: row.due_at, reminderAt: row.reminder_at, reminderAddedAt: row.reminder_added_at,
    reminderDeliveries: {},
    status: row.status, notes: row.notes,
    completedAt: row.completed_at, createdAt: row.created_at,
    todoistTaskId: row.todoist_task_id, todoistSyncedAt: row.todoist_synced_at,
    assignedRepId: contact.rows[0].marketing_owner_rep_id as string | null,
    assignedRepName: contact.rows[0].marketing_owner_rep_name as string | null,
  };
}

export async function updateMarketingLeadStatus(userId: string, contactId: string, status: MarketingLeadStatus): Promise<void> {
  const result = await query(
    `UPDATE sales_contacts SET marketing_lead_status=$3, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id`,
    [contactId, userId, status],
  );
  if (!result.rows[0]) throw new NotFoundError("Lead");
}

/** Assign a lead to a rep from the same account's roster; null clears the assignment. */
export async function assignMarketingLead(userId: string, contactId: string, repId: string | null): Promise<void> {
  const result = await query(
    `UPDATE sales_contacts c
        SET marketing_owner_rep_id=$3,updated_at=now()
      WHERE c.id=$1 AND c.user_id=$2
        AND ($3::uuid IS NULL OR EXISTS (
          SELECT 1 FROM sales_reps r WHERE r.id=$3 AND r.user_id=$2
        ))
      RETURNING c.id`,
    [contactId, userId, repId],
  );
  if (result.rows[0]) return;

  const contact = await query(`SELECT 1 FROM sales_contacts WHERE id=$1 AND user_id=$2`, [contactId, userId]);
  if (!contact.rows[0]) throw new NotFoundError("Lead");
  throw new AppError("Choose a rep from your account's roster.", 400);
}

export async function rescheduleMarketingFollowup(userId: string, id: string, dueAt: Date): Promise<void> {
  const previous = await query<{ due_at: Date; reminder_at: Date | null }>(
    `SELECT due_at,reminder_at FROM sales_marketing_followups WHERE id=$1 AND user_id=$2 AND status='open'`, [id, userId],
  );
  const row = previous.rows[0];
  if (!row) throw new AppError("This follow-up is no longer open.", 409);
  const reminderAt = row.reminder_at
    ? new Date(dueAt.getTime() - Math.max(0, new Date(row.due_at).getTime() - new Date(row.reminder_at).getTime()))
    : null;
  const result = await query(
    `UPDATE sales_marketing_followups SET due_at=$3,reminder_at=$4,
        reminder_added_at=CASE WHEN reminder_at IS DISTINCT FROM $4 THEN NULL ELSE reminder_added_at END,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND status='open' RETURNING id`, [id, userId, dueAt, reminderAt],
  );
  if (!result.rows[0]) throw new AppError("This follow-up is no longer open.", 409);
  if (row.reminder_at && reminderAt?.getTime() !== new Date(row.reminder_at).getTime()) {
    await resolveMarketingReminder(userId, id, new Date(row.reminder_at));
  }
}

export async function setMarketingFollowupReminder(userId: string, id: string, reminderAt: Date | null): Promise<void> {
  const previous = await query<{ reminder_at: Date | null }>(
    `SELECT reminder_at FROM sales_marketing_followups WHERE id=$1 AND user_id=$2 AND status='open'`, [id, userId],
  );
  const row = previous.rows[0];
  if (!row) throw new AppError("This follow-up is no longer open.", 409);
  const result = await query(
    `UPDATE sales_marketing_followups SET reminder_at=$3,
        reminder_added_at=CASE WHEN reminder_at IS DISTINCT FROM $3 THEN NULL ELSE reminder_added_at END,updated_at=now()
      WHERE id=$1 AND user_id=$2 AND status='open'
        AND ($3::timestamptz IS NULL OR $3::timestamptz<=due_at)
      RETURNING id`, [id, userId, reminderAt],
  );
  if (!result.rows[0]) throw new AppError("Set the reminder at or before the follow-up time, and make sure the task is still open.", 409);
  if (row.reminder_at && reminderAt?.getTime() !== new Date(row.reminder_at).getTime()) {
    await resolveMarketingReminder(userId, id, new Date(row.reminder_at));
  }
}

export async function completeMarketingFollowup(userId: string, id: string): Promise<void> {
  const existing = await query<{ reminder_at: Date | null }>(
    `SELECT reminder_at FROM sales_marketing_followups WHERE id=$1 AND user_id=$2 AND status='open'`, [id, userId],
  );
  const result = await query(
    `UPDATE sales_marketing_followups SET status='completed',completed_at=now(),updated_at=now()
      WHERE id=$1 AND user_id=$2 AND status='open' RETURNING id`, [id, userId],
  );
  if (!result.rows[0]) throw new AppError("This follow-up is no longer open.", 409);
  await resolveMarketingReminder(userId, id, existing.rows[0]?.reminder_at ?? null);
}

export async function cancelMarketingFollowup(userId: string, id: string): Promise<void> {
  const existing = await query<{ reminder_at: Date | null }>(
    `SELECT reminder_at FROM sales_marketing_followups WHERE id=$1 AND user_id=$2 AND status='open'`, [id, userId],
  );
  const result = await query(
    `UPDATE sales_marketing_followups SET status='cancelled',updated_at=now()
      WHERE id=$1 AND user_id=$2 AND status='open' RETURNING id`, [id, userId],
  );
  if (!result.rows[0]) throw new AppError("This follow-up is no longer open.", 409);
  await resolveMarketingReminder(userId, id, existing.rows[0]?.reminder_at ?? null);
}
