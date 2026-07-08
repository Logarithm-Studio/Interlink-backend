import { createHash } from "crypto";
import { query } from "../config/db";
import { AppUser, NormalizedEvent } from "../types";
import { emitTrigger } from "../triggers/emitter";
import { TriggerType } from "../triggers/types";
import { enqueueConflictDetection } from "./conflicts.service";
import {
  patchGoogleEvent,
  deleteGoogleEvent,
  declineGoogleEvent,
} from "./calendar/google";
import { BadRequestError, ForbiddenError } from "../utils/errors";

/**
 * Insert or update an event, deduplicating by (user_id, external_event_id, provider).
 * Creates a snapshot if the event was updated (not just inserted).
 */
export async function upsertEvent(event: NormalizedEvent): Promise<string> {
  const result = await query<{ id: string; xmax: string }>(
    `INSERT INTO events
       (user_id, external_event_id, provider, event_type, title, description,
        start_time, end_time, timezone, location, status, is_cancelled,
        organizer_email, attendees, is_recurring,
        series_id, occurrence_id, metadata, google_account_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW())
     ON CONFLICT (user_id, external_event_id, provider, google_account_id)
     DO UPDATE SET
       event_type      = EXCLUDED.event_type,
       title           = EXCLUDED.title,
       description     = EXCLUDED.description,
       start_time      = EXCLUDED.start_time,
       end_time        = EXCLUDED.end_time,
       timezone        = EXCLUDED.timezone,
       location        = EXCLUDED.location,
       status          = EXCLUDED.status,
       is_cancelled    = EXCLUDED.is_cancelled,
       organizer_email = EXCLUDED.organizer_email,
       attendees       = EXCLUDED.attendees,
       is_recurring    = EXCLUDED.is_recurring,
       series_id       = EXCLUDED.series_id,
       occurrence_id   = EXCLUDED.occurrence_id,
       metadata        = EXCLUDED.metadata,
       updated_at      = NOW()
     RETURNING id, xmax`,
    [
      event.userId,
      event.externalEventId,
      event.provider,
      event.eventType,
      event.title,
      event.description,
      event.startTime,
      event.endTime,
      event.timezone,
      event.location,
      event.status,
      event.isCancelled,
      event.organizerEmail,
      JSON.stringify(event.attendees),
      event.isRecurring,
      event.seriesId ?? null,
      event.occurrenceId ?? null,
      JSON.stringify(event.metadata),
      event.googleAccountId ?? null,
    ],
  );

  const row = result.rows[0];
  const wasUpdated = row.xmax !== "0"; // PostgreSQL: xmax > 0 means UPDATE, not INSERT

  // Snapshot on every write (INSERT and UPDATE) for a full audit timeline.
  await createSnapshot(row.id, event, wasUpdated);

  // Emit upserted trigger (fire-and-forget; never fails sync).
  const startIso =
    event.startTime instanceof Date
      ? event.startTime.toISOString()
      : String(event.startTime);
  const endIso =
    event.endTime instanceof Date
      ? event.endTime.toISOString()
      : String(event.endTime);

  emitTrigger({
    triggerType: TriggerType.CALENDAR_EVENT_UPSERTED,
    userId: event.userId,
    event: {
      id: row.id,
      externalEventId: event.externalEventId,
      provider: event.provider,
      eventType: event.eventType,
      title: event.title,
      description: event.description ?? null,
      startTime: startIso,
      endTime: endIso,
      organizerEmail: event.organizerEmail ?? null,
      isRecurring: event.isRecurring,
    },
    wasUpdated,
    observedAt: new Date().toISOString(),
  }).catch((err) =>
    console.error("[events] emitTrigger(upserted) failed:", err),
  );

  // Enqueue conflict detection for the event's time window (fire-and-forget).
  enqueueConflictDetection(event.userId, startIso, endIso).catch((err) =>
    console.error("[events] enqueueConflictDetection(upsert) failed:", err),
  );

  return row.id;
}

/**
 * Create an immutable snapshot of an event for the full audit timeline.
 * Fires on both INSERT and UPDATE so history is complete from the first sync.
 *
 * @param eventId    - The internal event row ID.
 * @param event      - The normalized event data at the time of write.
 * @param wasUpdated - True when this is an UPDATE, false for initial INSERT.
 */
async function createSnapshot(
  eventId: string,
  event: NormalizedEvent,
  wasUpdated: boolean,
): Promise<void> {
  // Include a deterministic hash so duplicate payloads can be detected.
  const payloadJson = JSON.stringify(event);
  const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
  await query(
    `INSERT INTO event_snapshots (event_id, snapshot)
     VALUES ($1, $2)`,
    [
      eventId,
      JSON.stringify({
        ...event,
        _meta: { wasUpdated, payloadHash },
      }),
    ],
  );
}

/**
 * Get events for a user, optionally filtered by time range.
 */
export async function getUserEvents(
  userId: string,
  from?: string,
  to?: string,
  googleAccountId?: string | null,
): Promise<NormalizedEvent[]> {
  const effectiveFrom = from ?? new Date().toISOString();

  let sql = `
    SELECT e.*, ga.email AS google_account_email, ga.role AS google_account_role,
           ga.is_primary AS google_account_is_primary
    FROM events e
    LEFT JOIN google_accounts ga ON ga.id = e.google_account_id
    WHERE e.user_id = $1
      AND e.is_cancelled = FALSE
  `;
  const params: unknown[] = [userId, effectiveFrom];
  let paramIdx = 3;

  sql += ` AND e.end_time >= $2`;

  if (to) {
    sql += ` AND e.start_time <= $${paramIdx}`;
    params.push(to);
    paramIdx++;
  }

  // Scope to the active mode's Google account (full multi-account behaviour).
  if (googleAccountId) {
    sql += ` AND e.google_account_id = $${paramIdx}`;
    params.push(googleAccountId);
    paramIdx++;
  }

  sql += " ORDER BY e.start_time ASC";

  const result = await query(sql, params);

  return result.rows.map(mapRowToEvent);
}

/**
 * Get a single event by ID (must belong to the user).
 */
export async function getEventById(
  userId: string,
  eventId: string,
): Promise<NormalizedEvent | null> {
  const result = await query(
    `SELECT e.*, ga.email AS google_account_email, ga.role AS google_account_role,
            ga.is_primary AS google_account_is_primary
       FROM events e
       LEFT JOIN google_accounts ga ON ga.id = e.google_account_id
      WHERE e.id = $1 AND e.user_id = $2`,
    [eventId, userId],
  );

  if (result.rows.length === 0) return null;
  return mapRowToEvent(result.rows[0]);
}

/**
 * Delete an event by ID.
 */
export async function deleteEvent(
  userId: string,
  eventId: string,
): Promise<boolean> {
  const result = await query<{
    external_event_id: string;
    provider: string;
    start_time: string;
    end_time: string;
  }>(
    "DELETE FROM events WHERE id = $1 AND user_id = $2 RETURNING external_event_id, provider, start_time, end_time",
    [eventId, userId],
  );
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) {
    const row = result.rows[0];
    emitTrigger({
      triggerType: TriggerType.CALENDAR_EVENT_DELETED,
      userId,
      event: {
        id: eventId,
        externalEventId: row.external_event_id,
        provider: row.provider as "google" | "microsoft",
      },
      observedAt: new Date().toISOString(),
    }).catch((err) =>
      console.error("[events] emitTrigger(deleted) failed:", err),
    );
    // Enqueue conflict detection so cleared conflicts are re-evaluated.
    enqueueConflictDetection(
      userId,
      new Date(row.start_time).toISOString(),
      new Date(row.end_time).toISOString(),
    ).catch((err) =>
      console.error("[events] enqueueConflictDetection(delete) failed:", err),
    );
  }
  return deleted;
}

// ─── Provider-backed mutations (Google) ─────────────────────────────────────

function assertOrganizer(event: NormalizedEvent, userEmail: string): void {
  const organizer = (event.organizerEmail || "").toLowerCase();
  if (!organizer || organizer !== userEmail.toLowerCase()) {
    throw new ForbiddenError("Only the event organizer can modify this event");
  }
}

function parseIso(dateStr: string, field: string): Date {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestError(`Invalid ${field}; must be ISO date string`);
  }
  return d;
}

export async function rescheduleEventAtProvider(
  user: AppUser,
  eventId: string,
  payload: {
    startTime: string;
    endTime: string;
    title?: string;
    description?: string | null;
    calendarId?: string;
  },
): Promise<NormalizedEvent> {
  const event = await getEventById(user.id, eventId);
  if (!event) {
    throw new BadRequestError("Event not found");
  }
  if (event.provider !== "google") {
    throw new BadRequestError("Only Google events can be rescheduled");
  }

  assertOrganizer(event, user.email);

  const start = parseIso(payload.startTime, "startTime");
  const end = parseIso(payload.endTime, "endTime");

  await patchGoogleEvent(
    user.id,
    event.externalEventId,
    {
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      title: payload.title ?? event.title,
      description:
        payload.description !== undefined
          ? payload.description
          : event.description,
      calendarId: payload.calendarId,
    },
    event.googleAccountId,
  );

  const updated: NormalizedEvent = {
    ...event,
    startTime: start,
    endTime: end,
    title: payload.title ?? event.title,
    description:
      payload.description !== undefined
        ? payload.description
        : event.description,
  };

  await upsertEvent(updated);
  return updated;
}

/**
 * Decline an event via the provider (Google Calendar).
 * Works for both organizers (deletes the event) and attendees (sets
 * responseStatus to "declined"). The event is removed from the local DB
 * after declining.
 */
export async function declineEventAtProvider(
  user: AppUser,
  eventId: string,
  calendarId = "primary",
): Promise<void> {
  const event = await getEventById(user.id, eventId);
  if (!event) {
    throw new BadRequestError("Event not found");
  }
  if (event.provider !== "google") {
    throw new BadRequestError("Only Google events can be declined");
  }

  await declineGoogleEvent(
    user.id,
    user.email,
    event.externalEventId,
    calendarId,
    event.googleAccountId,
  );

  // Remove from local DB after declining at Google.
  await deleteEvent(user.id, eventId);
}

export async function deleteEventAtProvider(
  user: AppUser,
  eventId: string,
  calendarId = "primary",
): Promise<boolean> {
  const event = await getEventById(user.id, eventId);
  if (!event) {
    throw new BadRequestError("Event not found");
  }

  // Try to delete in Google for both organizer and attendee; if Google rejects,
  // still delete locally so the event is removed from our UI.
  if (event.provider === "google") {
    try {
      await deleteGoogleEvent(
        user.id,
        event.externalEventId,
        calendarId,
        event.googleAccountId,
      );
    } catch (err) {
      console.warn(
        `[events] google delete skipped (user may be attendee): ${String(err)}`,
      );
    }
  }

  return deleteEvent(user.id, eventId);
}

/**
 * Delete an event by its external provider ID.
 *
 * Called during incremental sync when Google returns a cancelled/deleted event.
 * Silently succeeds (returns false) if the row doesn't exist — the event may
 * never have been synced in the first place.
 */
export async function deleteEventByExternalId(
  userId: string,
  externalEventId: string,
  provider: string,
  googleAccountId?: string | null,
): Promise<boolean> {
  const result = await query<{
    id: string;
    start_time: string;
    end_time: string;
  }>(
    `DELETE FROM events
      WHERE user_id = $1 AND external_event_id = $2 AND provider = $3
        AND ($4::uuid IS NULL OR google_account_id = $4)
      RETURNING id, start_time, end_time`,
    [userId, externalEventId, provider, googleAccountId ?? null],
  );
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) {
    const row = result.rows[0];
    emitTrigger({
      triggerType: TriggerType.CALENDAR_EVENT_DELETED,
      userId,
      event: {
        id: row?.id,
        externalEventId,
        provider: provider as "google" | "microsoft",
      },
      observedAt: new Date().toISOString(),
    }).catch((err) =>
      console.error("[events] emitTrigger(deleted by externalId) failed:", err),
    );
    // Enqueue conflict detection so cleared conflicts are re-evaluated.
    if (row?.start_time && row?.end_time) {
      enqueueConflictDetection(
        userId,
        new Date(row.start_time).toISOString(),
        new Date(row.end_time).toISOString(),
      ).catch((err) =>
        console.error(
          "[events] enqueueConflictDetection(deleteByExternalId) failed:",
          err,
        ),
      );
    }
  }
  return deleted;
}

// ─── Helpers ────────────────────────────────────────────────────────

function mapRowToEvent(row: Record<string, unknown>): NormalizedEvent {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    googleAccountId: (row.google_account_id as string | null) ?? null,
    googleAccountEmail: (row.google_account_email as string | null) ?? null,
    googleAccountRole: (row.google_account_role as "personal" | "professional" | null) ?? null,
    googleAccountIsPrimary: (row.google_account_is_primary as boolean | null) ?? null,
    externalEventId: row.external_event_id as string,
    provider: row.provider as "google" | "microsoft",
    eventType: row.event_type as string,
    title: row.title as string,
    description: row.description as string | null,
    startTime: new Date(row.start_time as string),
    endTime: new Date(row.end_time as string),
    timezone: (row.timezone as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    status: (row.status as string) ?? "confirmed",
    isCancelled: Boolean(row.is_cancelled),
    organizerEmail: row.organizer_email as string | null,
    attendees: (row.attendees || []) as NormalizedEvent["attendees"],
    isRecurring: row.is_recurring as boolean,
    seriesId: (row.series_id as string | null) ?? null,
    occurrenceId: (row.occurrence_id as string | null) ?? null,
    metadata: (row.metadata || {}) as Record<string, unknown>,
    updatedAt: new Date(row.updated_at as string),
    createdAt: new Date(row.created_at as string),
  };
}

export interface FlutterEventListItem {
  id: string;
  googleEventId: string;
  provider: "google" | "microsoft";
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  timezone: string | null;
  location: string | null;
  status: string;
  isCancelled: boolean;
  organizerEmail: string | null;
  attendeeCount: number;
  isRecurring: boolean;
  googleAccountId: string | null;
  calendarAccountEmail: string | null;
  calendarAccountRole: "personal" | "professional" | null;
  calendarAccountIsPrimary: boolean | null;
}

export interface FlutterEventDetail {
  id: string;
  googleEventId: string;
  provider: "google" | "microsoft";
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  timezone: string | null;
  location: string | null;
  status: string;
  isCancelled: boolean;
  organizerEmail: string | null;
  attendeeEmails: string[];
  attendees: NormalizedEvent["attendees"];
  isRecurring: boolean;
  googleAccountId: string | null;
  calendarAccountEmail: string | null;
  calendarAccountRole: "personal" | "professional" | null;
  calendarAccountIsPrimary: boolean | null;
}

export function toFlutterEventListItem(
  event: NormalizedEvent,
): FlutterEventListItem {
  return {
    id: event.id ?? "",
    googleEventId: event.externalEventId,
    provider: event.provider,
    title: event.title,
    description: event.description,
    startTime: event.startTime,
    endTime: event.endTime,
    timezone: event.timezone,
    location: event.location,
    status: event.status,
    isCancelled: event.isCancelled,
    organizerEmail: event.organizerEmail,
    attendeeCount: event.attendees.length,
    isRecurring: event.isRecurring,
    googleAccountId: event.googleAccountId ?? null,
    calendarAccountEmail: event.googleAccountEmail ?? null,
    calendarAccountRole: event.googleAccountRole ?? null,
    calendarAccountIsPrimary: event.googleAccountIsPrimary ?? null,
  };
}

export function toFlutterEventDetail(
  event: NormalizedEvent,
): FlutterEventDetail {
  return {
    id: event.id ?? "",
    googleEventId: event.externalEventId,
    provider: event.provider,
    title: event.title,
    description: event.description,
    startTime: event.startTime,
    endTime: event.endTime,
    timezone: event.timezone,
    location: event.location,
    status: event.status,
    isCancelled: event.isCancelled,
    organizerEmail: event.organizerEmail,
    attendeeEmails: event.attendees
      .map((a) => a.email)
      .filter((email) => typeof email === "string" && email.length > 0),
    attendees: event.attendees,
    isRecurring: event.isRecurring,
    googleAccountId: event.googleAccountId ?? null,
    calendarAccountEmail: event.googleAccountEmail ?? null,
    calendarAccountRole: event.googleAccountRole ?? null,
    calendarAccountIsPrimary: event.googleAccountIsPrimary ?? null,
  };
}
