/**
 * Sales-specific Google Calendar operations (reuses the shared Google OAuth token).
 * Mirrors calendar-hr.service.ts but for prospect/rep meetings.
 */

import { google } from "googleapis";
import { refreshGoogleTokenIfNeeded } from "../auth.service";

async function getCalendarClient(userId: string) {
  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.calendar({ version: "v3", auth });
}

export interface MeetingEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
  htmlLink: string;
}

/** Book a prospect meeting on the user's primary calendar and email invites. */
export async function scheduleLeadMeeting(
  userId: string,
  data: {
    title: string;
    prospectEmail: string;
    repEmail?: string;
    startTime: string; // ISO
    endTime: string; // ISO
    notes?: string;
  },
): Promise<MeetingEvent> {
  const calendar = await getCalendarClient(userId);
  const attendees = [{ email: data.prospectEmail }, ...(data.repEmail ? [{ email: data.repEmail }] : [])];

  const res = await calendar.events.insert({
    calendarId: "primary",
    sendUpdates: "all",
    requestBody: {
      summary: data.title,
      description: data.notes,
      start: { dateTime: data.startTime },
      end: { dateTime: data.endTime },
      attendees,
    },
  });

  return {
    id: res.data.id ?? "",
    summary: data.title,
    start: data.startTime,
    end: data.endTime,
    attendees: attendees.map((a) => a.email),
    htmlLink: res.data.htmlLink ?? "",
  };
}
