/** /api/v1/hr — HR Agent (Google Sheets + Calendar + Gemini) */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { listSpreadsheets, readSheetRange, appendSheetRow } from "../services/hr/sheets.service";
import { getUpcomingInterviews, scheduleInterview } from "../services/hr/calendar-hr.service";
import { generateHeadcountReport, suggestInterviewSlots, startOnboarding } from "../services/hr/hr-workflows.service";

const router = Router();
router.use(authMiddleware as never);

// ─── Sheets ───────────────────────────────────────────────────────────────────

router.get("/sheets", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ sheets: await listSpreadsheets((req as AuthenticatedRequest).user.id) });
  } catch (err) { next(err); }
});

router.get("/sheets/:id/range", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const range = String(req.query.range ?? "Sheet1!A1:Z1000");
    res.json({ rows: await readSheetRange(user.id, req.params.id, range) });
  } catch (err) { next(err); }
});

const AppendBody = z.object({ range: z.string().default("Sheet1!A:Z"), values: z.array(z.string()) });
router.post("/sheets/:id/append", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = AppendBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("values array is required.");
    await appendSheetRow(user.id, req.params.id, parsed.data.range, parsed.data.values);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Headcount ────────────────────────────────────────────────────────────────

router.get("/headcount/:spreadsheetId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const range = String(req.query.range ?? "Sheet1!A1:Z1000");
    res.json(await generateHeadcountReport((req as AuthenticatedRequest).user.id, req.params.spreadsheetId, range));
  } catch (err) { next(err); }
});

// ─── Interviews ───────────────────────────────────────────────────────────────

router.get("/interviews/upcoming", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ interviews: await getUpcomingInterviews((req as AuthenticatedRequest).user.id) });
  } catch (err) { next(err); }
});

router.get("/interviews/slots", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const date = String(req.query.date ?? new Date().toISOString().split("T")[0]);
    res.json(await suggestInterviewSlots(user.id, date));
  } catch (err) { next(err); }
});

const ScheduleBody = z.object({
  candidateName: z.string().min(1),
  candidateEmail: z.string().email(),
  interviewerEmail: z.string().email(),
  role: z.string().min(1),
  startTime: z.string(),
  endTime: z.string(),
  location: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/interviews/schedule", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ScheduleBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("candidateName, emails, role, and times are required.");
    res.status(201).json({ interview: await scheduleInterview(user.id, parsed.data) });
  } catch (err) { next(err); }
});

// ─── Onboarding ───────────────────────────────────────────────────────────────

const OnboardBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().min(1),
  department: z.string().min(1),
  startDate: z.string(),
  spreadsheetId: z.string().optional(),
  managerEmail: z.string().email().optional(),
});

router.post("/onboarding", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = OnboardBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("name, email, role, department, and startDate are required.");
    res.status(201).json(await startOnboarding(user.id, parsed.data));
  } catch (err) { next(err); }
});

export default router;
