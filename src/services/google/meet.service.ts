/**
 * Google Meet scheduling (Personal Mode). Creates a Google Calendar event with a
 * Meet conference link attached. Uses the existing `calendar` OAuth scope — Meet
 * needs no separate scope; the link is generated via conferenceData.createRequest.
 */

import { randomUUID } from "crypto";
import { google } from "googleapis";
import { refreshGoogleTokenIfNeeded } from "../auth.service";

async function getCalendarClient(userId: string) {
  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.calendar({ version: "v3", auth });
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
  data: { title: string; startTime: string; endTime: string; attendees?: string[]; description?: string },
): Promise<ScheduledMeeting> {
  const calendar = await getCalendarClient(userId);
  const attendees = (data.attendees ?? []).filter(Boolean).map((email) => ({ email }));

  const res = await calendar.events.insert({
    calendarId: "primary",
    sendUpdates: attendees.length ? "all" : "none",
    conferenceDataVersion: 1,
    requestBody: {
      summary: data.title,
      description: data.description,
      start: { dateTime: data.startTime },
      end: { dateTime: data.endTime },
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
