/**
 * Notification orchestration service.
 *
 * Provides two public functions:
 *
 *  - `enqueueNotification`  — called from the workflow `notify` step handler
 *    (registry.ts) to add a delivery job to the notifications queue.
 *
 *  - `deliverNotification`  — called by the notifications BullMQ processor
 *    (notifications.processor.ts) to actually deliver the notification:
 *    1. Attempt FCM push delivery.
 *    2. On failure / no-token / not-configured, fall back to Gmail draft.
 *    3. Record a `notification_deliveries` row for each channel attempted.
 *    4. Write an `audit_log` entry.
 *
 * Both functions are idempotent: duplicate BullMQ retries produce no
 * side effects beyond the first successful delivery.
 */

import crypto from "crypto";
import { enqueueJob } from "../jobQueue.service";
import { query } from "../../config/db";
import { recordAuditLog } from "../../security/idempotency";
import { JobType } from "../../jobs/schemas/envelope";
import { sendPushNotification } from "./push.service";
import type { PushAction } from "./push.service";
import { sendEmailFallback } from "./emailFallback.service";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface NotificationEnqueueParams {
  executionId: string;
  stepId: string;
  userId: string;
  title: string;
  body: string;
  /** Actions with their signed tokens, already produced by `signActionToken`. */
  actions: PushAction[];
}

export interface NotificationDeliverParams extends NotificationEnqueueParams {
  /** Target email for fallback.  Looked up from `users` if not provided. */
  toEmail?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Stable hash of a sorted set of action keys — used in the BullMQ job ID. */
function actionSetHash(actions: PushAction[]): string {
  const sorted = [...actions].sort((a, b) =>
    a.actionKey.localeCompare(b.actionKey),
  );
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sorted.map((a) => a.actionKey)))
    .digest("hex")
    .slice(0, 12);
}

/** Idempotency key for a notification_deliveries row. */
function deliveryIdempotencyKey(
  executionId: string,
  stepId: string,
  channel: string,
): string {
  return `notif:delivery:${executionId}:${stepId}:${channel}`;
}

/** Persist a notification_deliveries row; ON CONFLICT DO NOTHING for retries. */
async function recordDelivery(params: {
  executionId: string;
  stepId: string;
  userId: string;
  channel: "push" | "email_fallback";
  status: "sent" | "failed" | "skipped";
  idempotencyKey: string;
  providerMessageId?: string;
  error?: string;
}): Promise<void> {
  await query(
    `INSERT INTO notification_deliveries
       (execution_id, step_id, user_id, channel, status, idempotency_key,
        provider_message_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      params.executionId,
      params.stepId,
      params.userId,
      params.channel,
      params.status,
      params.idempotencyKey,
      params.providerMessageId ?? null,
      params.error ?? null,
    ],
  ).catch((err) =>
    console.error("[notification.service] Failed to record delivery:", err),
  );
}

/** Get user email from the `users` table. */
async function getUserEmail(userId: string): Promise<string | null> {
  const res = await query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  return res.rows[0]?.email ?? null;
}

// ─── enqueueNotification ──────────────────────────────────────────────────────

/**
 * Enqueue a `notification.send` job in the notifications BullMQ queue.
 *
 * The job ID is stable across retries so duplicate enqueues are coalesced by
 * BullMQ's job deduplication.
 */
export async function enqueueNotification(
  params: NotificationEnqueueParams,
): Promise<void> {
  const { executionId, stepId, userId, title, body, actions } = params;
  const jobId = `notif|send|${executionId}|${stepId}|${actionSetHash(actions)}`;

  await enqueueJob(
    "notifications",
    {
      jobType: JobType.NOTIFICATION_SEND,
      requestId: crypto.randomUUID(),
      idempotencyKey: jobId,
      userId,
      payload: { executionId, stepId, title, body, actions },
    },
    { jobId, retries: 3 },
  );

  console.log(
    `[notification.service] enqueued job=${jobId} executionId=${executionId}`,
  );
}

// ─── deliverNotification ──────────────────────────────────────────────────────

/**
 * Deliver a notification.  Called by the notifications BullMQ processor.
 *
 * Strategy:
 *   1. Try FCM push first.
 *   2. If push is not sent for any reason, send an email fallback.
 *   3. Record delivery rows and an audit log entry regardless.
 */
export async function deliverNotification(
  params: NotificationDeliverParams,
): Promise<void> {
  const { executionId, stepId, userId, title, body, actions } = params;

  // ── Push delivery ──────────────────────────────────────────────────────────
  const pushIdempotencyKey = deliveryIdempotencyKey(
    executionId,
    stepId,
    "push",
  );

  const pushResult = await sendPushNotification({
    userId,
    title,
    body,
    actions,
  });

  await recordDelivery({
    executionId,
    stepId,
    userId,
    channel: "push",
    status: pushResult.sent ? "sent" : "failed",
    idempotencyKey: pushIdempotencyKey,
    providerMessageId: pushResult.messageId,
    error: pushResult.sent ? undefined : (pushResult.reason ?? "unknown"),
  });

  // ── Email fallback ─────────────────────────────────────────────────────────
  const emailIdempotencyKey = deliveryIdempotencyKey(
    executionId,
    stepId,
    "email_fallback",
  );

  if (!pushResult.sent) {
    const toEmail = params.toEmail ?? (await getUserEmail(userId));
    if (toEmail) {
      const emailResult = await sendEmailFallback({
        executionId,
        stepId,
        toEmail,
        userId,
        title,
        body,
        actions,
      });

      await recordDelivery({
        executionId,
        stepId,
        userId,
        channel: "email_fallback",
        status: emailResult.sent ? "sent" : "failed",
        idempotencyKey: emailIdempotencyKey,
        providerMessageId: emailResult.draftId,
        error: emailResult.sent ? undefined : (emailResult.reason ?? "unknown"),
      });
    } else {
      console.warn(
        `[notification.service] No email address for user=${userId}, cannot send fallback`,
      );
      await recordDelivery({
        executionId,
        stepId,
        userId,
        channel: "email_fallback",
        status: "skipped",
        idempotencyKey: emailIdempotencyKey,
        error: "no_email_address",
      });
    }
  } else {
    // Push succeeded — record email channel as skipped for audit completeness.
    await recordDelivery({
      executionId,
      stepId,
      userId,
      channel: "email_fallback",
      status: "skipped",
      idempotencyKey: emailIdempotencyKey,
    });
  }

  // ── Audit log ──────────────────────────────────────────────────────────────
  await recordAuditLog({
    userId,
    actorType: "system",
    action: "notification.delivered",
    entityType: "workflow_execution",
    entityId: executionId,
    idempotencyKey: `notif:audit:${executionId}:${stepId}`,
    payload: {
      stepId,
      title,
      pushed: pushResult.sent,
      pushReason: pushResult.reason,
    },
  }).catch((err) =>
    console.error("[notification.service] audit_log write failed:", err),
  );

  console.log(
    `[notification.service] delivered executionId=${executionId} stepId=${stepId} pushed=${pushResult.sent}`,
  );
}
