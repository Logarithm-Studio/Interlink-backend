/**
 * Google Meet scheduling (Personal Mode). Creates a Google Calendar event with a
 * Meet conference link attached. Uses the existing `calendar` OAuth scope — Meet
 * needs no separate scope; the link is generated via conferenceData.createRequest.
 */

import { randomUUID } from "crypto";
import { google } from "googleapis";
import { refreshGoogleTokenIfNeeded } from "../auth.service";

type CalendarClient = ReturnType<typeof google.calendar>;

async function getCalendarClient(userId: string): Promise<CalendarClient> {
  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.calendar({ version: "v3", auth });
}

/** The user's primary-calendar timezone — their real location zone, set in Google Calendar. */
async function getPrimaryCalendarTimeZone(calendar: CalendarClient): Promise<string | undefined> {
  try {
    const res = await calendar.calendars.get({ calendarId: "primary" });
    return res.data.timeZone ?? undefined;
  } catch {
    return undefined;
  }
}

export interface ScheduledMeeting {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
  htmlLink: string;
  meetLink: string;
}

/** Create a calendar event with a Google Meet link and (optionally) email invites. */
export async function scheduleMeetMeeting(
  userId: string,
  data: {
    title: string;
    startTime: string;
    endTime: string;
    attendees?: string[];
    description?: string;
    /** IANA timezone (e.g. "Asia/Dhaka") the wall-clock start/end should be read in. */
    timeZone?: string;
  },
): Promise<ScheduledMeeting> {
  const calendar = await getCalendarClient(userId);
  const attendees = (data.attendees ?? []).filter(Boolean).map((email) => ({ email }));

  // Anchor the event to a real zone so a naive wall-clock time (e.g. "3pm") lands at
  // 3pm in the USER's zone, not the calendar-server default or UTC. Prefer the zone the
  // caller passed (from the device); fall back to the user's own primary-calendar zone.
  const timeZone = data.timeZone?.trim() || (await getPrimaryCalendarTimeZone(calendar));

  const res = await calendar.events.insert({
    calendarId: "primary",
    sendUpdates: attendees.length ? "all" : "none",
    conferenceDataVersion: 1,
    requestBody: {
      summary: data.title,
      description: data.description,
      start: { dateTime: data.startTime, timeZone },
      end: { dateTime: data.endTime, timeZone },
      attendees,
      conferenceData: {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });

  const meetLink =
    res.data.hangoutLink ??
    res.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    "";

  return {
    id: res.data.id ?? "",
    summary: data.title,
    start: data.startTime,
    end: data.endTime,
    attendees: attendees.map((a) => a.email),
    htmlLink: res.data.htmlLink ?? "",
    meetLink,
  };
}
