/**
 * HR workflow automations.
 *
 * 1. Headcount Report — reads employee sheet → Gemini summary.
 * 2. Interview Suggestion — finds free slots for an interview.
 * 3. Onboarding Checklist — adds new hire to sheet + creates calendar events.
 */

import { geminiGenerateContent } from "../ai/geminiClient";
import { readSheetRange, appendSheetRow } from "./sheets.service";
import { getUpcomingInterviews, scheduleInterview, findFreeSlots } from "./calendar-hr.service";

// ─── Headcount Report ─────────────────────────────────────────────────────────

export interface HeadcountReport {
  totalEmployees: number;
  byDepartment: Record<string, number>;
  summary: string;
  isFallback: boolean;
}

export async function generateHeadcountReport(
  userId: string,
  spreadsheetId: string,
  range: string = "Sheet1!A1:Z1000",
): Promise<HeadcountReport> {
  const rows = await readSheetRange(userId, spreadsheetId, range);
  if (rows.length < 2) {
    return { totalEmployees: 0, byDepartment: {}, summary: "No employee data found in sheet.", isFallback: true };
  }

  const headers = rows[0].values.map((h) => h.toLowerCase());
  const deptIdx = headers.findIndex((h) => h.includes("dept") || h.includes("department") || h.includes("team"));

  const employees = rows.slice(1).filter((r) => r.values.some((v) => v.trim()));
  const byDepartment: Record<string, number> = {};

  if (deptIdx >= 0) {
    for (const row of employees) {
      const dept = row.values[deptIdx]?.trim() || "Unknown";
      byDepartment[dept] = (byDepartment[dept] ?? 0) + 1;
    }
  }

  const snapshot = [
    `Total employees: ${employees.length}`,
    Object.entries(byDepartment).map(([d, n]) => `${d}: ${n}`).join(", "),
  ].filter(Boolean).join("\n");

  let summary = `Total headcount: ${employees.length} employees.`;
  let isFallback = true;

  try {
    const result = await geminiGenerateContent({
      system: "You are an HR assistant. Write a concise 2-3 sentence headcount summary for a manager. Return JSON: { summary: string }",
      parts: [{ text: snapshot }],
      json: true,
    });
    const parsed = JSON.parse(result.raw) as { summary?: string };
    if (parsed.summary) { summary = parsed.summary; isFallback = false; }
  } catch { /* use fallback */ }

  return { totalEmployees: employees.length, byDepartment, summary, isFallback };
}

// ─── Interview Suggestion ─────────────────────────────────────────────────────

export interface InterviewSuggestion {
  slots: { start: string; end: string }[];
  upcomingCount: number;
}

export async function suggestInterviewSlots(
  userId: string,
  date: string,
): Promise<InterviewSuggestion> {
  const [slots, upcoming] = await Promise.all([
    findFreeSlots(userId, date, 60),
    getUpcomingInterviews(userId),
  ]);
  return { slots, upcomingCount: upcoming.length };
}

// ─── Onboarding Checklist ─────────────────────────────────────────────────────

export interface OnboardingResult {
  sheetRowAdded: boolean;
  calendarEventId: string | null;
  checklist: string[];
}

const ONBOARDING_CHECKLIST = [
  "Send welcome email",
  "Set up workstation / equipment",
  "Create accounts (email, Slack, GitHub)",
  "Schedule 1:1 with manager (Day 1)",
  "Team introduction meeting",
  "HR documentation & compliance",
  "Share employee handbook",
  "30-day check-in scheduled",
];

export async function startOnboarding(
  userId: string,
  data: {
    name: string;
    email: string;
    role: string;
    department: string;
    startDate: string;
    spreadsheetId?: string;
    managerEmail?: string;
  },
): Promise<OnboardingResult> {
  let sheetRowAdded = false;
  let calendarEventId: string | null = null;

  if (data.spreadsheetId) {
    try {
      await appendSheetRow(userId, data.spreadsheetId, "Sheet1!A:Z", [
        data.name,
        data.email,
        data.role,
        data.department,
        data.startDate,
        "Active",
        new Date().toISOString().split("T")[0],
      ]);
      sheetRowAdded = true;
    } catch { /* non-fatal */ }
  }

  if (data.managerEmail) {
    try {
      const startTime = `${data.startDate}T10:00:00`;
      const endTime = `${data.startDate}T10:30:00`;
      const event = await scheduleInterview(userId, {
        candidateName: data.name,
        candidateEmail: data.email,
        interviewerEmail: data.managerEmail,
        role: data.role,
        startTime,
        endTime,
        notes: `Welcome 1:1 for new hire starting ${data.startDate}`,
      });
      calendarEventId = event.id;
    } catch { /* non-fatal */ }
  }

  return { sheetRowAdded, calendarEventId, checklist: ONBOARDING_CHECKLIST };
}
