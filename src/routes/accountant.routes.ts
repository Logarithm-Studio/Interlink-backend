/**
 * /api/v1/accountant/* — Professional Mode (Accountant) endpoints.
 *
 * Iteration 1: Dunning over seeded invoices (synchronous send mirroring the
 * Personal decline flow). Iteration 2 adds AI insights, dunning preview/edit/
 * bulk, Expense Auditing, Flash Reporting, and the "Ask your AI accountant" chat.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../utils/errors";
import {
  countOverdue,
  getInvoiceById,
  getReminderLogs,
  listInvoices,
  markOverdueInvoices,
  seedDemoInvoices,
  type InvoiceStatus,
} from "../services/accountant/invoices.service";
import {
  AuthError,
  bulkPreviewReminders,
  bulkSendReminders,
  previewReminder,
  sendInvoiceReminder,
} from "../services/accountant/dunning.service";
import {
  getExpenseById,
  listExpenses,
  resolveExpense,
  runExpenseAudit,
  seedDemoExpenses,
  type ExpenseStatus,
} from "../services/accountant/expenses.service";
import { getArInsights } from "../services/accountant/insights.service";
import { emailFlashReport, getFlashReport } from "../services/accountant/reporting.service";
import { chat, getChatHistory } from "../services/accountant/assistant.service";
import { sendPushNotification } from "../services/notifications/push.service";

const router = Router();
router.use(authMiddleware as never);

const INVOICE_STATUSES: InvoiceStatus[] = ["open", "overdue", "reminded", "paid"];
const EXPENSE_STATUSES: ExpenseStatus[] = ["pending", "flagged", "approved", "dismissed"];
const escalationToneSchema = z.enum(["friendly", "firm", "final"]).optional();

/** Map a Gmail AuthError to a 401 reconnect message. */
function mapSendError(err: unknown, next: NextFunction): void {
  if (err instanceof AuthError) {
    next(
      new UnauthorizedError(
        "Google account needs to be reconnected before sending email.",
      ),
    );
    return;
  }
  next(err);
}

// ─── Insights ────────────────────────────────────────────────────────────────
router.get("/insights", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json(await getArInsights(user.id));
  } catch (err) {
    next(err);
  }
});

// ─── Invoices ────────────────────────────────────────────────────────────────
router.get("/invoices", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const statusParam = req.query.status as string | undefined;
    const status =
      statusParam && INVOICE_STATUSES.includes(statusParam as InvoiceStatus)
        ? (statusParam as InvoiceStatus)
        : undefined;
    res.json({ invoices: await listInvoices(user.id, { status }) });
  } catch (err) {
    next(err);
  }
});

router.get("/invoices/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const invoice = await getInvoiceById(user.id, req.params.id);
    if (!invoice) throw new NotFoundError("Invoice");
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});

router.get("/invoices/:id/reminder-logs", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const invoice = await getInvoiceById(user.id, req.params.id);
    if (!invoice) throw new NotFoundError("Invoice");
    res.json({ logs: await getReminderLogs(user.id, req.params.id) });
  } catch (err) {
    next(err);
  }
});

// Generate a reminder draft WITHOUT sending (preview / regenerate).
const PreviewBody = z.object({
  regenerate: z.boolean().optional(),
  escalationTone: escalationToneSchema,
});
router.post("/invoices/:id/preview-reminder", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = PreviewBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid request body.");
    const draft = await previewReminder(user, req.params.id, {
      regenerate: parsed.data.regenerate,
      escalationTone: parsed.data.escalationTone,
    });
    res.json(draft);
  } catch (err) {
    next(err);
  }
});

// Send a reminder. Optional { subject, body } overrides = the edited draft.
const SendBody = z.object({
  subject: z.string().optional(),
  body: z.string().optional(),
  escalationTone: escalationToneSchema,
});
router.post("/invoices/:id/send-reminder", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = SendBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid request body.");
    const result = await sendInvoiceReminder({
      user,
      invoiceId: req.params.id,
      subjectOverride: parsed.data.subject,
      bodyOverride: parsed.data.body,
      escalationTone: parsed.data.escalationTone,
    });
    res.json(result);
  } catch (err) {
    mapSendError(err, next);
  }
});

// ─── Bulk dunning ──────────────────────────────────────────────────────────────
const BulkPreviewBody = z.object({ invoiceIds: z.array(z.string()).optional() });
router.post("/invoices/bulk-remind/preview", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = BulkPreviewBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid request body.");
    res.json({ drafts: await bulkPreviewReminders(user, parsed.data.invoiceIds) });
  } catch (err) {
    next(err);
  }
});

const BulkSendBody = z.object({
  items: z
    .array(
      z.object({
        invoiceId: z.string(),
        subject: z.string().optional(),
        body: z.string().optional(),
      }),
    )
    .min(1),
});
router.post("/invoices/bulk-remind/send", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = BulkSendBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid request body: items required.");
    res.json({ outcomes: await bulkSendReminders(user, parsed.data.items) });
  } catch (err) {
    mapSendError(err, next);
  }
});

// ─── Expenses ────────────────────────────────────────────────────────────────
router.get("/expenses", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const statusParam = req.query.status as string | undefined;
    const status =
      statusParam && EXPENSE_STATUSES.includes(statusParam as ExpenseStatus)
        ? (statusParam as ExpenseStatus)
        : undefined;
    res.json({ expenses: await listExpenses(user.id, { status }) });
  } catch (err) {
    next(err);
  }
});

router.get("/expenses/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const expense = await getExpenseById(user.id, req.params.id);
    if (!expense) throw new NotFoundError("Expense");
    res.json({ expense });
  } catch (err) {
    next(err);
  }
});

router.post("/expenses/audit", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const audit = await runExpenseAudit(user.id);
    res.json({ ...audit, expenses: await listExpenses(user.id) });
  } catch (err) {
    next(err);
  }
});

const ResolveBody = z.object({ action: z.enum(["approve", "dismiss"]) });
router.post("/expenses/:id/resolve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ResolveBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("action must be 'approve' or 'dismiss'.");
    const expense = await getExpenseById(user.id, req.params.id);
    if (!expense) throw new NotFoundError("Expense");
    await resolveExpense(user.id, req.params.id, parsed.data.action);
    res.json({ ok: true, expense: await getExpenseById(user.id, req.params.id) });
  } catch (err) {
    next(err);
  }
});

// ─── Flash report ───────────────────────────────────────────────────────────
router.get("/reports/flash", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json(await getFlashReport(user.id));
  } catch (err) {
    next(err);
  }
});

router.post("/reports/flash/email", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json(await emailFlashReport(user));
  } catch (err) {
    mapSendError(err, next);
  }
});

// ─── Assistant ───────────────────────────────────────────────────────────────
const ChatBody = z.object({
  message: z.string().min(1).max(2000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .optional(),
});
router.post("/assistant/chat", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ChatBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("message is required.");
    res.json(await chat(user.id, parsed.data.message, parsed.data.history));
  } catch (err) {
    next(err);
  }
});

router.get("/assistant/history", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json({ messages: await getChatHistory(user.id) });
  } catch (err) {
    next(err);
  }
});

// ─── Scan + seed ────────────────────────────────────────────────────────────
router.post("/scan", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const markedOverdue = await markOverdueInvoices(user.id);
    const overdueCount = await countOverdue(user.id);
    let notified = false;
    if (overdueCount > 0) {
      const push = await sendPushNotification({
        userId: user.id,
        title: "Overdue invoices need attention",
        body: `You have ${overdueCount} overdue invoice${overdueCount === 1 ? "" : "s"}. Review and send reminders.`,
        actions: [],
        data: { type: "accountant.dunning", screen: "tasks" },
      });
      notified = push.sent;
    }
    res.json({ markedOverdue, overdueCount, notified });
  } catch (err) {
    next(err);
  }
});

const SeedBodySchema = z.object({ clientEmail: z.string().email().optional() });
router.post("/seed-demo", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = SeedBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new BadRequestError("Invalid request body: clientEmail must be a valid email.");
    }
    const clientEmail = parsed.data.clientEmail ?? user.email;
    const insertedInvoices = await seedDemoInvoices(user.id, clientEmail);
    const insertedExpenses = await seedDemoExpenses(user.id);
    res.json({
      insertedInvoices,
      insertedExpenses,
      invoices: await listInvoices(user.id),
      expenses: await listExpenses(user.id),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
