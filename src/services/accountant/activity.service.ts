/**
 * Agent activity feed service (Professional Mode, iter3).
 * Records everything the agent does + "suggested" items awaiting approval.
 */

import { query } from "../../config/db";

export type ActivityStatus = "done" | "suggested" | "failed" | "dismissed";

export interface Activity {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  entityType: string | null;
  entityId: string | null;
  status: ActivityStatus;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export async function recordActivity(params: {
  userId: string;
  kind: string;
  title: string;
  detail?: string;
  entityType?: string;
  entityId?: string;
  status?: ActivityStatus;
  payload?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const res = await query<{ id: string }>(
    `INSERT INTO accountant_activity
       (user_id, kind, title, detail, entity_type, entity_id, status, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id`,
    [
      params.userId,
      params.kind,
      params.title,
      params.detail ?? null,
      params.entityType ?? null,
      params.entityId ?? null,
      params.status ?? "done",
      JSON.stringify(params.payload ?? {}),
    ],
  );
  return { id: res.rows[0].id };
}

function mapRow(r: {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  entity_type: string | null;
  entity_id: string | null;
  status: ActivityStatus;
  payload: Record<string, unknown> | null;
  created_at: Date;
}): Activity {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    entityType: r.entity_type,
    entityId: r.entity_id,
    status: r.status,
    payload: r.payload ?? {},
    createdAt: r.created_at,
  };
}

export async function listActivity(userId: string, limit = 50): Promise<Activity[]> {
  const res = await query(
    `SELECT id, kind, title, detail, entity_type, entity_id, status, payload, created_at
       FROM accountant_activity
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return res.rows.map(mapRow as never);
}

export async function getActivity(userId: string, id: string): Promise<Activity | null> {
  const res = await query(
    `SELECT id, kind, title, detail, entity_type, entity_id, status, payload, created_at
       FROM accountant_activity WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return res.rows[0] ? mapRow(res.rows[0] as never) : null;
}

export async function setActivityStatus(
  userId: string,
  id: string,
  status: ActivityStatus,
): Promise<void> {
  await query(
    `UPDATE accountant_activity SET status = $3 WHERE id = $1 AND user_id = $2`,
    [id, userId, status],
  );
}

/** True if there's already an unresolved suggestion for this entity (avoid dupes). */
export async function hasPendingSuggestion(
  userId: string,
  entityId: string,
): Promise<boolean> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM accountant_activity
      WHERE user_id = $1 AND entity_id = $2 AND status = 'suggested'`,
    [userId, entityId],
  );
  return parseInt(res.rows[0]?.count ?? "0", 10) > 0;
}

/** Count reminders the agent sent today (for the daily-send-cap guardrail). */
export async function countRemindersSentToday(userId: string): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM accountant_activity
      WHERE user_id = $1 AND kind = 'reminder_sent' AND status = 'done'
        AND created_at >= date_trunc('day', now())`,
    [userId],
  );
  return parseInt(res.rows[0]?.count ?? "0", 10);
}
