import { query } from "../config/db";

export type AttendanceResponseValue = "yes" | "no";

export interface AttendanceResponseRecord {
  id: string;
  userId: string;
  eventId: string;
  response: AttendanceResponseValue;
  handledAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface AttendanceResponseRow {
  id: string;
  user_id: string;
  event_id: string;
  response: AttendanceResponseValue;
  handled_at: Date;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: AttendanceResponseRow): AttendanceResponseRecord {
  return {
    id: row.id,
    userId: row.user_id,
    eventId: row.event_id,
    response: row.response,
    handledAt: row.handled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertAttendanceResponse(params: {
  userId: string;
  eventId: string;
  response: AttendanceResponseValue;
}): Promise<AttendanceResponseRecord> {
  const result = await query<AttendanceResponseRow>(
    `INSERT INTO attendance_responses
       (user_id, event_id, response, handled_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (user_id, event_id)
     DO UPDATE SET
       response = EXCLUDED.response,
       handled_at = NOW(),
       updated_at = NOW()
     RETURNING id, user_id, event_id, response, handled_at, created_at, updated_at`,
    [params.userId, params.eventId, params.response],
  );

  return mapRow(result.rows[0]);
}

export async function getAttendanceResponseForEvent(
  userId: string,
  eventId: string,
): Promise<AttendanceResponseRecord | null> {
  const result = await query<AttendanceResponseRow>(
    `SELECT id, user_id, event_id, response, handled_at, created_at, updated_at
       FROM attendance_responses
      WHERE user_id = $1 AND event_id = $2
      LIMIT 1`,
    [userId, eventId],
  );

  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listAttendanceResponsesForEvents(
  userId: string,
  eventIds: string[],
): Promise<Record<string, AttendanceResponseValue>> {
  if (eventIds.length === 0) {
    return {};
  }

  const result = await query<AttendanceResponseRow>(
    `SELECT id, user_id, event_id, response, handled_at, created_at, updated_at
       FROM attendance_responses
      WHERE user_id = $1
        AND event_id = ANY($2::uuid[])`,
    [userId, eventIds],
  );

  return result.rows.reduce<Record<string, AttendanceResponseValue>>(
    (acc, row) => {
      acc[row.event_id] = row.response;
      return acc;
    },
    {},
  );
}
