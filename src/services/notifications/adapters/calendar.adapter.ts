/**
 * Calendar adapter — CHANGES AND REQUESTS ONLY, never standing events.
 *
 * This distinction is the whole reason Calendar can be a hub source at all. The Events screen is
 * already a standing calendar queue: it lists your events and prompts Yes/No on each one. If the
 * hub also carried "you have a 3pm", the same item would appear twice in the app, and the widget
 * would repeat the list sitting directly beneath it.
 *
 * So the Events list answers "what is on my calendar", and the hub answers "what HAPPENED to my
 * calendar while I was not looking":
 *
 *   - an event you had said yes to was **cancelled**
 *   - an event **moved** after you had already seen it
 *   - two events **conflict**
 *
 * Nothing else in the app surfaces any of these three. A cancelled 9am is the highest-value
 * notification in the product — it is the one that changes what you do with the next hour.
 *
 * Calendar items are excluded from the Events widget (`getFeed({ includeCalendar: false })`) and
 * appear only on the full notification screen, which has no event list under it.
 */

import { query } from "../../../config/db";
import { logger } from "../../../observability/logger";
import {
  upsertItem,
  markResolvedBySource,
  setSourceHealth,
  HUB_WEIGHTS,
  type HubMode,
} from "../hub.service";

/** Events are account-scoped; the account's role decides which feed the item lands in. */
interface CalendarRow {
  id: string;
  title: string;
  start_time: Date;
  location: string | null;
  organizer_email: string | null;
  updated_at: Date;
  created_at: Date;
  is_cancelled: boolean;
  account_role: "personal" | "professional" | null;
}

const modeOf = (role: string | null): HubMode =>
  role === "professional" ? "professional" : "personal";

function whenLabel(d: Date | string): string {
  return new Date(d).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function runCalendarAdapter(userId: string): Promise<number> {
  let written = 0;
  try {
    written += await cancelledEvents(userId);
    written += await rescheduledEvents(userId);
    written += await activeConflicts(userId);
    await setSourceHealth(userId, "calendar", "ok");
  } catch (err) {
    logger.warn("[hub:calendar] adapter failed", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    await setSourceHealth(
      userId,
      "calendar",
      "error",
      "Calendar changes could not be read on the last sync.",
    );
  }
  return written;
}

/**
 * Upcoming events that were cancelled.
 *
 * Weighted above a normal calendar change: a cancellation frees time you are currently planning
 * around, and acting on it early is the entire value.
 */
async function cancelledEvents(userId: string): Promise<number> {
  const res = await query<CalendarRow>(
    `SELECT e.id, e.title, e.start_time, e.location, e.organizer_email,
            e.updated_at, e.created_at, e.is_cancelled, ga.role AS account_role
       FROM events e
       LEFT JOIN google_accounts ga ON ga.id = e.google_account_id
      WHERE e.user_id = $1
        AND (e.is_cancelled = TRUE OR e.status = 'cancelled')
        AND e.start_time >= now()
        AND e.start_time <= now() + interval '14 days'
      ORDER BY e.start_time ASC
      LIMIT 25`,
    [userId],
  );

  for (const row of res.rows) {
    await upsertItem({
      userId,
      mode: modeOf(row.account_role),
      source: "calendar",
      kind: "calendar_cancelled",
      dedupKey: `calendar:cancelled:${row.id}`,
      title: `Cancelled — ${row.title}`,
      preview: `Was ${whenLabel(row.start_time)}. That time is free now.`,
      actor: row.organizer_email,
      weight: HUB_WEIGHTS.meeting,
      externalRef: { eventId: row.id, route: "/(home)/events" },
      occurredAt: new Date(row.updated_at),
    });
  }
  return res.rows.length;
}

/**
 * Upcoming events that moved after you had already seen them.
 *
 * "Already seen" is approximated two ways, and both matter: the row was edited well after it was
 * first synced (`updated_at > created_at + 1 min`, which filters out the initial import writing
 * both timestamps together), and — the stronger signal — the user had already answered Yes/No on
 * it. Answering and then having it move is exactly the case worth interrupting for.
 */
async function rescheduledEvents(userId: string): Promise<number> {
  const res = await query<CalendarRow & { response: string | null }>(
    `SELECT e.id, e.title, e.start_time, e.location, e.organizer_email,
            e.updated_at, e.created_at, e.is_cancelled, ga.role AS account_role,
            ar.response
       FROM events e
       LEFT JOIN google_accounts ga ON ga.id = e.google_account_id
       LEFT JOIN attendance_responses ar
              ON ar.event_id = e.id AND ar.user_id = e.user_id
      WHERE e.user_id = $1
        AND COALESCE(e.is_cancelled, FALSE) = FALSE
        AND e.start_time >= now()
        AND e.start_time <= now() + interval '14 days'
        AND e.updated_at > e.created_at + interval '1 minute'
        AND e.updated_at > now() - interval '7 days'
      ORDER BY e.start_time ASC
      LIMIT 25`,
    [userId],
  );

  for (const row of res.rows) {
    await upsertItem({
      userId,
      mode: modeOf(row.account_role),
      source: "calendar",
      kind: "calendar_changed",
      dedupKey: `calendar:changed:${row.id}`,
      title: `Updated — ${row.title}`,
      preview: row.response
        ? `Now ${whenLabel(row.start_time)}. You had already replied "${row.response}".`
        : `Now ${whenLabel(row.start_time)}.`,
      actor: row.organizer_email,
      weight: row.response ? HUB_WEIGHTS.meeting : HUB_WEIGHTS.calendarChange,
      externalRef: { eventId: row.id, route: "/(home)/events" },
      occurredAt: new Date(row.updated_at),
    });
  }
  return res.rows.length;
}

/**
 * Active double-bookings from the `conflicts` registry, which `conflicts.processor` already
 * maintains — this adapter only translates them into hub rows.
 *
 * Cleared conflicts are resolved rather than left to age out: the user fixed their calendar, and
 * the hub must not keep insisting there is a problem.
 */
async function activeConflicts(userId: string): Promise<number> {
  const res = await query<{
    id: string;
    status: string;
    severity: string;
    overlap_minutes: number;
    last_detected_at: Date;
    title_a: string;
    title_b: string;
    start_a: Date;
    account_role: "personal" | "professional" | null;
  }>(
    `SELECT c.id, c.status, c.severity, c.overlap_minutes, c.last_detected_at,
            a.title AS title_a, b.title AS title_b, a.start_time AS start_a,
            ga.role AS account_role
       FROM conflicts c
       JOIN events a ON a.id = c.event_a_id
       JOIN events b ON b.id = c.event_b_id
       LEFT JOIN google_accounts ga ON ga.id = a.google_account_id
      WHERE c.user_id = $1
        AND a.start_time >= now() - interval '1 day'
      ORDER BY a.start_time ASC
      LIMIT 25`,
    [userId],
  );

  let written = 0;
  for (const row of res.rows) {
    const dedupKey = `calendar:conflict:${row.id}`;

    if (row.status !== "active") {
      await markResolvedBySource(userId, dedupKey);
      continue;
    }

    await upsertItem({
      userId,
      mode: modeOf(row.account_role),
      source: "calendar",
      kind: "calendar_conflict",
      dedupKey,
      title: `Double-booked — ${row.title_a}`,
      preview: `Overlaps "${row.title_b}" by ${row.overlap_minutes} min on ${whenLabel(
        row.start_a,
      )}.`,
      actor: "Calendar",
      weight: row.severity === "high" ? HUB_WEIGHTS.meeting : HUB_WEIGHTS.calendarChange,
      externalRef: { conflictId: row.id, route: "/(home)/events" },
      occurredAt: new Date(row.last_detected_at),
    });
    written += 1;
  }
  return written;
}
