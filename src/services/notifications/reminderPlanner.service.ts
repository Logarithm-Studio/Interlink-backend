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
  geocodeAddress,
  getDistanceFromOrigin,
  type LatLng,
} from "../googleMaps.service";

const DEFAULT_LEAD_MINUTES = 15;
/** If driving ETA is under this, treat the user as already at the venue. */
const STATIONARY_ETA_THRESHOLD_SECONDS = 60;
/** Max event window we plan reminders for — keeps response sizes small. */
const HORIZON_HOURS = 24;

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
    const geo = await geocodeAddress(destinationAddress);
    const res = await getDistanceFromOrigin({
      origin,
      destination: { location: geo.location },
      mode: "driving",
      departureTime: "now",
    });
    const seconds =
      res.durationInTrafficSeconds ?? res.durationSeconds ?? 0;
    return { seconds };
  } catch (err) {
    return {
      seconds: 0,
      reason: err instanceof Error ? err.message : "maps_lookup_failed",
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
        return {
          ...base,
          travelSeconds: 0,
          mode: "stationary",
          notifyAt: new Date(
            ev.start_time.getTime() - leadSeconds * 1000,
          ).toISOString(),
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

      return {
        ...base,
        travelSeconds: effectiveTravel,
        mode,
        notifyAt: new Date(
          ev.start_time.getTime() - (leadSeconds + effectiveTravel) * 1000,
        ).toISOString(),
        reason,
      };
    }),
  );

  return { plans, leadMinutes };
}
