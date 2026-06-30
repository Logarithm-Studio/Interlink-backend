/**
 * HR-specific Calendar operations.
 * Reuses existing Google Calendar OAuth tokens.
 */

import { google } from "googleapis";
import { refreshGoogleTokenIfNeeded } from "../auth.service";

async function getCalendarClient(userId: string) {
  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.calendar({ version: "v3", auth });
}

export interface InterviewEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
  location: string | null;
  description: string | null;
  htmlLink: string;
}

const INTERVIEW_KEYWORDS = ["interview", "screening", "onsite", "panel", "technical round", "hr round"];

export async function getUpcomingInterviews(userId: string): Promise<InterviewEvent[]> {
  const calendar = await getCalendarClient(userId);
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now,
    timeMax: future,
    maxResults: 100,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = (res.data.items ?? []).filter((e) => {
    const title = (e.summary ?? "").toLowerCase();
    return INTERVIEW_KEYWORDS.some((kw) => title.includes(kw));
  });

  return events.map((e) => ({
    id: e.id ?? "",
    summary: e.summary ?? "",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    attendees: (e.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
    location: e.location ?? null,
    description: e.description ?? null,
    htmlLink: e.htmlLink ?? "",
  }));
}

export async function scheduleInterview(
  userId: string,
  data: {
    candidateName: string;
    candidateEmail: string;
    interviewerEmail: string;
    role: string;
    startTime: string;
    endTime: string;
    location?: string;
    notes?: string;
  },
): Promise<InterviewEvent> {
  const calendar = await getCalendarClient(userId);

  const summary = `Interview: ${data.candidateName} — ${data.role}`;
  const description = [
    `Candidate: ${data.candidateName} (${data.candidateEmail})`,
    `Role: ${data.role}`,
    data.notes ? `Notes: ${data.notes}` : "",
  ].filter(Boolean).join("\n");

  const res = await calendar.events.insert({
    calendarId: "primary",
    sendUpdates: "all",
    requestBody: {
      summary,
      description,
      location: data.location,
      start: { dateTime: data.startTime },
      end: { dateTime: data.endTime },
      attendees: [
        { email: data.candidateEmail, displayName: data.candidateName },
        { email: data.interviewerEmail },
      ],
    },
  });

  return {
    id: res.data.id ?? "",
    summary,
    start: data.startTime,
    end: data.endTime,
    attendees: [data.candidateEmail, data.interviewerEmail],
    location: data.location ?? null,
    description,
    htmlLink: res.data.htmlLink ?? "",
  };
}

export async function findFreeSlots(
  userId: string,
  date: string,
  durationMinutes: number = 60,
): Promise<{ start: string; end: string }[]> {
  const calendar = await getCalendarClient(userId);

  const dayStart = new Date(`${date}T09:00:00`);
  const dayEnd = new Date(`${date}T18:00:00`);

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      items: [{ id: "primary" }],
    },
  });

  const busy = (res.data.calendars?.["primary"]?.busy ?? []).map((b) => ({
    start: new Date(b.start ?? "").getTime(),
    end: new Date(b.end ?? "").getTime(),
  }));

  const slots: { start: string; end: string }[] = [];
  let cursor = dayStart.getTime();

  while (cursor + durationMinutes * 60 * 1000 <= dayEnd.getTime()) {
    const slotEnd = cursor + durationMinutes * 60 * 1000;
    const isBlocked = busy.some((b) => cursor < b.end && slotEnd > b.start);
    if (!isBlocked) {
      slots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(slotEnd).toISOString(),
      });
    }
    cursor += 30 * 60 * 1000;
  }

  return slots.slice(0, 6);
}
