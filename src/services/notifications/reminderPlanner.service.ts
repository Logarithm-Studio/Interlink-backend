/**
 * Reminder planner.
 *
 * Given a user's current coordinates, compute *when* each upcoming event's
 * reminder should fire on the user's device.  The device is responsible for
 * actually displaying the notification (expo-notifications, local only) —
 * the server only answers: "for event X starting at T, fire the reminder at
 * `notifyAt`".
 *
 * Rules (single formula for both states):
 *   notifyAt = startTime − (leadSeconds + travelSeconds)
 *
 *   - Stationary (user is at or very near the venue): travelSeconds ≈ 0,
 *     so the notification fires exactly `leadSeconds` before the event.
 *   - Moving: travelSeconds is the driving ETA from the user's current
 *     location to the event venue, so the notification fires in time for the
 *     user to leave and arrive `leadSeconds` early.
 *
 * Events with no geocodable location, or lookups that fail for any reason,
 * fall back to the stationary calculation.
 */
import { query } from "../../config/db";
import {
  getDistanceFromOrigin,
  type LatLng,
} from "../googleMaps.service";

const DEFAULT_LEAD_MINUTES = 15;
/** If driving ETA is under this, treat the user as already at the venue. */
const STATIONARY_ETA_THRESHOLD_SECONDS = 60;
/** Max event window we plan reminders for — keeps response sizes small. */
const HORIZON_HOURS = 24;

const MAPS_DISABLED_RE =
  /(legacy api|service_disabled|not been used|not activated|disabled)/i;
const MAPS_DENIED_RE =
  /(permission_denied|request_denied|forbidden|api key)/i;
const MAPS_NO_ROUTE_RE =
  /(zero_results|no route|no distance result|element status)/i;

export interface ReminderPlan {
  eventId: string;
  title: string;
  startTime: string;
  location: string | null;
  notifyAt: string;
  leadSeconds: number;
  travelSeconds: number;
  mode: "stationary" | "moving";
  reason?: string;
}

interface EventRow {
  id: string;
  title: string;
  start_time: Date;
  location: string | null;
}

function toTravelFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");

  if (MAPS_DISABLED_RE.test(message)) {
    return "maps_api_disabled";
  }
  if (MAPS_DENIED_RE.test(message)) {
    return "maps_request_denied";
  }
  if (MAPS_NO_ROUTE_RE.test(message)) {
    return "maps_no_route";
  }

  return "maps_lookup_failed";
}

async function loadUpcomingEvents(
  userId: string,
  horizonHours: number,
): Promise<EventRow[]> {
  const res = await query<EventRow>(
    `SELECT id, title, start_time, location
       FROM events
      WHERE user_id = $1
        AND is_cancelled = FALSE
        AND start_time >  NOW()
        AND start_time <= NOW() + ($2 || ' hours')::interval
      ORDER BY start_time ASC`,
    [userId, String(horizonHours)],
  );
  return res.rows;
}

async function getUserLeadMinutes(userId: string): Promise<number> {
  const res = await query<{ lead_minutes: number | null }>(
    `SELECT reminder_lead_minutes AS lead_minutes
       FROM user_preferences
      WHERE user_id = $1
      LIMIT 1`,
    [userId],
  ).catch(() => ({ rows: [] as { lead_minutes: number | null }[] }));

  const raw = res.rows[0]?.lead_minutes;
  return typeof raw === "number" && raw > 0 ? raw : DEFAULT_LEAD_MINUTES;
}

/**
 * Resolve the driving ETA from `origin` to `destinationAddress`.
 * Returns 0 on any failure (caller then falls back to stationary mode).
 */
async function resolveTravelSeconds(
  origin: LatLng,
  destinationAddress: string,
): Promise<{ seconds: number; reason?: string }> {
  try {
    const res = await getDistanceFromOrigin({
      origin,
      destination: { address: destinationAddress },
      mode: "driving",
      departureTime: "now",
    });
    const seconds =
      res.durationInTrafficSeconds ?? res.durationSeconds ?? 0;
    return { seconds };
  } catch (err) {
    const reason = toTravelFailureReason(err);
    console.warn(
      `[ReminderPlanner] Travel lookup failed (${reason}) for destination "${destinationAddress}"`,
      err,
    );
    return {
      seconds: 0,
      reason,
    };
  }
}

export interface ComputeRemindersParams {
  userId: string;
  origin: LatLng | null;
  horizonHours?: number;
}

export async function computeReminders(
  params: ComputeRemindersParams,
): Promise<{ plans: ReminderPlan[]; leadMinutes: number }> {
  const { userId, origin } = params;
  const horizonHours = params.horizonHours ?? HORIZON_HOURS;

  const [events, leadMinutes] = await Promise.all([
    loadUpcomingEvents(userId, horizonHours),
    getUserLeadMinutes(userId),
  ]);

  const leadSeconds = leadMinutes * 60;

  console.log(
    `[ReminderPlanner] Computing reminders for user ${userId}:`,
    `${events.length} events, lead time ${leadMinutes}min (${leadSeconds}s)`,
    origin ? `, location (${origin.lat.toFixed(4)}, ${origin.lng.toFixed(4)})` : ", no location",
  );

  const plans: ReminderPlan[] = await Promise.all(
    events.map(async (ev): Promise<ReminderPlan> => {
      const base = {
        eventId: ev.id,
        title: ev.title,
        startTime: ev.start_time.toISOString(),
        location: ev.location,
        leadSeconds,
      };

      // No origin (no permission yet) or no event location → stationary.
      if (!origin || !ev.location || !ev.location.trim()) {
        const notifyAt = new Date(
          ev.start_time.getTime() - leadSeconds * 1000,
        );

        console.log(
          `[ReminderPlanner] Event "${ev.title}": STATIONARY (no location)`,
          `\n  Start: ${ev.start_time.toISOString()}`,
          `\n  Lead: ${leadMinutes}min`,
          `\n  Notify at: ${notifyAt.toISOString()}`,
        );

        return {
          ...base,
          travelSeconds: 0,
          mode: "stationary",
          notifyAt: notifyAt.toISOString(),
          reason: !origin ? "no_origin" : "no_event_location",
        };
      }

      const { seconds, reason } = await resolveTravelSeconds(
        origin,
        ev.location,
      );

      const mode: "stationary" | "moving" =
        seconds < STATIONARY_ETA_THRESHOLD_SECONDS ? "stationary" : "moving";

      const effectiveTravel = mode === "stationary" ? 0 : seconds;
      const notifyAt = new Date(
        ev.start_time.getTime() - (leadSeconds + effectiveTravel) * 1000,
      );

      console.log(
        `[ReminderPlanner] Event "${ev.title}": ${mode.toUpperCase()}`,
        `\n  Start: ${ev.start_time.toISOString()}`,
        `\n  Lead: ${leadMinutes}min (${leadSeconds}s)`,
        `\n  Travel: ${Math.round(seconds / 60)}min (${seconds}s)`,
        `\n  Effective travel: ${Math.round(effectiveTravel / 60)}min (${effectiveTravel}s)`,
        `\n  Total buffer: ${Math.round((leadSeconds + effectiveTravel) / 60)}min`,
        `\n  Notify at: ${notifyAt.toISOString()}`,
        `\n  Time until notify: ${Math.round((notifyAt.getTime() - Date.now()) / 1000)}s`,
        reason ? `\n  Reason: ${reason}` : "",
      );

      return {
        ...base,
        travelSeconds: effectiveTravel,
        mode,
        notifyAt: notifyAt.toISOString(),
        reason,
      };
    }),
  );

  console.log(`[ReminderPlanner] Generated ${plans.length} reminder plans`);

  return { plans, leadMinutes };
}
