import { calendar_v3 } from "googleapis";
import { NormalizedEvent, Attendee } from "../../types";
import { EventTypeRule, classifyEvent } from "../eventTypeRules.service";

/**
 * Convert a raw Google Calendar event into our NormalizedEvent format.
 *
 * @param raw    - Raw Google Calendar API event object.
 * @param userId - The Interlink user this event belongs to.
 * @param rules  - Pre-loaded, priority-ordered event type rules from the DB.
 *                 Load once per sync batch via `loadActiveRules()` and reuse.
 *                 Pass an empty array to default every event to 'general'.
 */
export function normalizeGoogleEvent(
  raw: calendar_v3.Schema$Event,
  userId: string,
  rules: EventTypeRule[],
  sourceCalendarId?: string,
): NormalizedEvent | null {
  // Cancelled events are handled upstream (deleted from DB); skip here.
  if (raw.status === "cancelled") return null;

  // Events must have start and end times and a provider event ID.
  const startTime = raw.start?.dateTime || raw.start?.date;
  const endTime = raw.end?.dateTime || raw.end?.date;
  if (!startTime || !endTime || !raw.id) return null;

  const title = raw.summary || "(No title)";
  const description = raw.description || null;
  const timezone = raw.start?.timeZone || raw.end?.timeZone || null;
  const location = raw.location || null;
  const status = raw.status || "confirmed";
  const organizerEmail = raw.organizer?.email || null;

  const attendees: Attendee[] = (raw.attendees || []).map((a) => ({
    email: a.email || "",
    displayName: a.displayName || undefined,
    responseStatus: a.responseStatus || undefined,
    optional: a.optional || false,
  }));

  // ── Data-driven classification ────────────────────────────────────────────
  // Event type is determined purely by the pre-loaded rule set from the DB.
  // No hard-coded logic here — add/modify/deactivate rules in event_type_rules.
  const eventType = classifyEvent(rules, {
    title,
    description,
    organizerEmail,
    provider: "google",
  });

  return {
    userId,
    externalEventId: raw.id,
    provider: "google",
    eventType,
    title,
    description,
    startTime: new Date(startTime),
    endTime: new Date(endTime),
    timezone,
    location,
    status,
    isCancelled: false,
    organizerEmail,
    attendees,
    isRecurring: !!raw.recurringEventId,
    // Recurring event identifiers — null for standalone events.
    seriesId: raw.recurringEventId ?? null,
    occurrenceId: raw.recurringEventId ? (raw.id ?? null) : null,
    metadata: {
      calendarId: sourceCalendarId ?? "primary",
      htmlLink: raw.htmlLink,
      location,
      hangoutLink: raw.hangoutLink,
      conferenceData: raw.conferenceData,
      recurringEventId: raw.recurringEventId,
    },
  };
}
