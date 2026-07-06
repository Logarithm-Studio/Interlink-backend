import { google, calendar_v3 } from "googleapis";
import {
  refreshGoogleTokenIfNeeded,
  refreshGoogleTokenForAccount,
} from "../auth.service";
import { BadRequestError } from "../../utils/errors";

/**
 * Resolve a fresh Google access token for calendar calls. When a specific
 * account id is given (multi-account sync) use it; otherwise fall back to the
 * user's primary account (single-account / legacy callers).
 */
async function resolveAccessToken(
  userId: string,
  googleAccountId?: string | null,
): Promise<string> {
  return googleAccountId
    ? refreshGoogleTokenForAccount(googleAccountId)
    : refreshGoogleTokenIfNeeded(userId);
}

function getGoogleStatusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const asRecord = err as {
    response?: { status?: number };
    code?: string | number;
    status?: number;
  };
  if (typeof asRecord.response?.status === "number") {
    return asRecord.response.status;
  }
  if (typeof asRecord.status === "number") {
    return asRecord.status;
  }
  const codeAsNumber = Number(asRecord.code);
  return Number.isFinite(codeAsNumber) ? codeAsNumber : undefined;
}

async function listCandidateCalendarIds(
  cal: calendar_v3.Calendar,
  preferredCalendarId?: string,
): Promise<string[]> {
  const ids = new Set<string>();

  if (preferredCalendarId?.trim()) {
    ids.add(preferredCalendarId.trim());
  }
  ids.add("primary");

  try {
    let pageToken: string | undefined;
    do {
      const response = await cal.calendarList.list({
        maxResults: 250,
        pageToken,
        fields: "items(id),nextPageToken",
      });

      for (const item of response.data.items ?? []) {
        if (item.id) {
          ids.add(item.id);
        }
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    // Non-fatal: we'll still try preferred + primary.
    console.warn("[google.calendar] Could not list calendar IDs:", err);
  }

  return [...ids];
}

async function resolveEventAcrossCalendars(
  cal: calendar_v3.Calendar,
  eventId: string,
  preferredCalendarId?: string,
): Promise<{ calendarId: string; event: calendar_v3.Schema$Event }> {
  const candidates = await listCandidateCalendarIds(cal, preferredCalendarId);

  for (const calendarId of candidates) {
    try {
      const response = await cal.events.get({ calendarId, eventId });
      return { calendarId, event: response.data };
    } catch (err) {
      const status = getGoogleStatusCode(err);
      if (status === 404) {
        continue;
      }
      throw err;
    }
  }

  throw new BadRequestError(
    "Could not locate this Google event in your connected calendars.",
  );
}

function findSelfAttendee(
  event: calendar_v3.Schema$Event,
  userEmail: string,
): calendar_v3.Schema$EventAttendee | undefined {
  const attendees = event.attendees ?? [];

  const explicitSelf = attendees.find((attendee) => attendee.self === true);
  if (explicitSelf) {
    return explicitSelf;
  }

  const normalizedUserEmail = userEmail.trim().toLowerCase();
  return attendees.find(
    (attendee) => (attendee.email ?? "").toLowerCase() === normalizedUserEmail,
  );
}

// ─── Error types ───────────────────────────────────────────────────────────

/**
 * Thrown when Google Calendar returns 410 Gone, meaning the syncToken is
 * invalid/expired. The caller must clear the stored cursor and schedule a
 * full resync.
 */
export class GoogleSyncTokenExpiredError extends Error {
  constructor(message = "Google Calendar sync token expired (410 Gone)") {
    super(message);
    this.name = "GoogleSyncTokenExpiredError";
  }
}

// ─── Full time-window fetch ────────────────────────────────────────────────

/**
 * Fetch calendar events from Google Calendar API using a time window.
 *
 * Used for the initial full sync and as a fallback when no syncToken is stored.
 * The `nextSyncToken` on the final page is returned so the caller can seed the
 * incremental cursor immediately after the first successful full sync.
 *
 * @param userId     - Used to retrieve and refresh stored tokens.
 * @param since      - Optional ISO date string; defaults to 30 days ago.
 * @param calendarId - Defaults to 'primary'.
 */
export async function fetchGoogleEvents(
  userId: string,
  since?: string,
  calendarId = "primary",
  googleAccountId?: string | null,
): Promise<{
  events: calendar_v3.Schema$Event[];
  nextSyncToken: string | null;
}> {
  const accessToken = await resolveAccessToken(userId, googleAccountId);

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });

  const cal = google.calendar({ version: "v3", auth: oauth2Client });

  const allEvents: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;

  // Default: past 30 days → next 90 days
  const timeMin =
    since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  do {
    const response = await cal.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true, // Expand recurring events into instances
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });

    allEvents.push(...(response.data.items ?? []));
    pageToken = response.data.nextPageToken ?? undefined;

    // NOTE: Google does NOT return nextSyncToken when singleEvents=true.
    // We collect it here defensively, but the seed call below is the real source.
    if (response.data.nextSyncToken) {
      nextSyncToken = response.data.nextSyncToken;
    }
  } while (pageToken);

  // ── Seed the incremental cursor ──────────────────────────────────────────
  // events.list with singleEvents=true never returns nextSyncToken (Google
  // limitation).  Make one extra minimal call without singleEvents purely to
  // get a valid syncToken we can use for future incremental syncs.
  if (!nextSyncToken) {
    // nextSyncToken is only returned on the FINAL page of results.
    // To avoid re-downloading event payloads, request only pagination tokens.
    let seedPageToken: string | undefined;
    do {
      const seedResp = await cal.events.list({
        calendarId,
        maxResults: 2500,
        pageToken: seedPageToken,
        showDeleted: false,
        fields: "nextPageToken,nextSyncToken",
      });
      seedPageToken = seedResp.data.nextPageToken ?? undefined;
      if (seedResp.data.nextSyncToken) {
        nextSyncToken = seedResp.data.nextSyncToken;
      }
    } while (seedPageToken);
  }

  return { events: allEvents, nextSyncToken };
}

// ─── Incremental fetch using syncToken ────────────────────────────────────

/**
 * Fetch only the changes since the last sync using a Google Calendar syncToken.
 *
 * - Must be called ONLY when a valid syncToken is stored.
 * - `showDeleted: true` is required so that cancelled events are returned.
 * - Pagination: intermediate pages carry `nextPageToken`; `nextSyncToken`
 *   only appears on the FINAL page.
 * - Throws `GoogleSyncTokenExpiredError` on 410 Gone so the caller can clear
 *   the cursor and enqueue a full resync.
 *
 * @param userId     - Used to retrieve and refresh stored tokens.
 * @param syncToken  - The previously stored nextSyncToken.
 * @param calendarId - Defaults to 'primary'.
 */
export async function fetchGoogleEventsIncremental(
  userId: string,
  syncToken: string,
  calendarId = "primary",
  googleAccountId?: string | null,
): Promise<{
  events: calendar_v3.Schema$Event[];
  nextSyncToken: string | null;
}> {
  const accessToken = await resolveAccessToken(userId, googleAccountId);

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });

  const cal = google.calendar({ version: "v3", auth: oauth2Client });

  const allEvents: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  let finalSyncToken: string | null = null;

  try {
    do {
      const response = await cal.events.list({
        calendarId,
        // syncToken goes on the FIRST request only; subsequent pages use pageToken
        ...(pageToken ? { pageToken } : { syncToken }),
        showDeleted: true, // Required to detect cancellations/deletions
        maxResults: 250,
      });

      allEvents.push(...(response.data.items ?? []));
      pageToken = response.data.nextPageToken ?? undefined;

      if (response.data.nextSyncToken) {
        finalSyncToken = response.data.nextSyncToken;
      }
    } while (pageToken);
  } catch (err: unknown) {
    // Google returns 410 Gone when the syncToken is stale or the calendar
    // has been reset. Signal this to the caller via a typed error.
    const status =
      (err as { response?: { status?: number }; code?: string | number })
        ?.response?.status ?? Number((err as { code?: string | number })?.code);

    if (status === 410) {
      throw new GoogleSyncTokenExpiredError();
    }
    throw err;
  }

  return { events: allEvents, nextSyncToken: finalSyncToken };
}

// ─── Mutations (update/delete) ─────────────────────────────────────────────

export interface GoogleEventPatch {
  startTime: string; // ISO
  endTime: string; // ISO
  title?: string;
  description?: string | null;
  calendarId?: string;
}

/** Patch a Google Calendar event (times/title/description). */
export async function patchGoogleEvent(
  userId: string,
  eventId: string,
  patch: GoogleEventPatch,
  googleAccountId?: string | null,
): Promise<calendar_v3.Schema$Event> {
  const accessToken = await resolveAccessToken(userId, googleAccountId);
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  const cal = google.calendar({ version: "v3", auth: oauth2Client });

  const startIso = new Date(patch.startTime).toISOString();
  const endIso = new Date(patch.endTime).toISOString();

  const body: calendar_v3.Schema$Event = {
    start: { dateTime: startIso },
    end: { dateTime: endIso },
  };
  if (patch.title) body.summary = patch.title;
  if (patch.description !== undefined)
    body.description = patch.description ?? null;

  try {
    const resp = await cal.events.patch({
      calendarId: patch.calendarId ?? "primary",
      eventId,
      requestBody: body,
      sendUpdates: "all",
    });
    return resp.data;
  } catch (err) {
    throw new BadRequestError(`Failed to update Google event: ${String(err)}`);
  }
}

/** Delete a Google Calendar event. */
export async function deleteGoogleEvent(
  userId: string,
  eventId: string,
  calendarId = "primary",
  googleAccountId?: string | null,
): Promise<void> {
  const accessToken = await resolveAccessToken(userId, googleAccountId);
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  const cal = google.calendar({ version: "v3", auth: oauth2Client });

  try {
    await cal.events.delete({ calendarId, eventId, sendUpdates: "all" });
  } catch (err) {
    throw new BadRequestError(`Failed to delete Google event: ${String(err)}`);
  }
}

/**
 * Accept a Google Calendar event by setting the authenticated user's
 * attendee `responseStatus` to `"accepted"`.
 *
 * Mirror of `declineGoogleEvent`: patches the attendee list when the user
 * appears as an attendee, no-ops (gracefully) when they are the sole organizer
 * with no self-attendee row (they created it, so it's already "accepted").
 */
export async function acceptGoogleEvent(
  userId: string,
  userEmail: string,
  eventId: string,
  calendarId = "primary",
  googleAccountId?: string | null,
): Promise<void> {
  const accessToken = await resolveAccessToken(userId, googleAccountId);
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  const cal = google.calendar({ version: "v3", auth: oauth2Client });

  try {
    const resolved = await resolveEventAcrossCalendars(cal, eventId, calendarId);
    const attendees = resolved.event.attendees ?? [];
    const selfAttendee = findSelfAttendee(resolved.event, userEmail);

    if (!selfAttendee) {
      // Organizer-owned events often don't include a self attendee row.
      if (resolved.event.organizer?.self) {
        return;
      }

      throw new BadRequestError(
        "Could not find your attendee entry for this Google event.",
      );
    }

    // Only patch if the status isn't already accepted (avoids a needless write).
    if (selfAttendee.responseStatus === "accepted") return;

    selfAttendee.responseStatus = "accepted";
    await cal.events.patch({
      calendarId: resolved.calendarId,
      eventId,
      requestBody: { attendees },
      sendUpdates: "none", // Accepting doesn't warrant notifying other attendees.
    });
  } catch (err) {
    throw new BadRequestError(`Failed to accept Google event: ${String(err)}`);
  }
}

/**
 * Decline a Google Calendar event by setting the authenticated user's
 * attendee `responseStatus` to `"declined"`.
 *
 * Works for both organizers and attendees:
 * - The API call fetches the current event, locates the user's attendee
 *   entry by email, patches it, and uses `sendUpdates: "all"` so Google
 *   notifies other attendees.
 * - If the user's email is not in the attendee list (e.g. they ARE the
 *   organizer and no self-attendee exists) we fall back to deleting the
 *   event from their calendar.
 */
export async function declineGoogleEvent(
  userId: string,
  userEmail: string,
  eventId: string,
  calendarId = "primary",
  googleAccountId?: string | null,
): Promise<void> {
  const accessToken = await resolveAccessToken(userId, googleAccountId);
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  const cal = google.calendar({ version: "v3", auth: oauth2Client });

  try {
    const resolved = await resolveEventAcrossCalendars(cal, eventId, calendarId);
    const attendees = resolved.event.attendees ?? [];
    const selfAttendee = findSelfAttendee(resolved.event, userEmail);

    if (selfAttendee) {
      // Set responseStatus to declined and PATCH the event.
      selfAttendee.responseStatus = "declined";
      await cal.events.patch({
        calendarId: resolved.calendarId,
        eventId,
        requestBody: { attendees },
        sendUpdates: "all",
      });
    } else if (resolved.event.organizer?.self) {
      // User is likely the sole organizer with no self-attendee row.
      // Deleting the event from their calendar effectively declines it.
      await cal.events.delete({
        calendarId: resolved.calendarId,
        eventId,
        sendUpdates: "all",
      });
    } else {
      throw new BadRequestError(
        "Could not find your attendee entry for this Google event.",
      );
    }
  } catch (err) {
    throw new BadRequestError(`Failed to decline Google event: ${String(err)}`);
  }
}
