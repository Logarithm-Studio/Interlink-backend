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
  createInvoice,
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
  createExpenseFromReceipt,
  createExpenseManual,
  getExpenseById,
  listExpenses,
  resolveExpense,
  runExpenseAudit,
  seedDemoExpenses,
  type ExpenseStatus,
} from "../services/accountant/expenses.service";
import { extractReceipt } from "../services/ai/multimodal.service";
import { getArInsights } from "../services/accountant/insights.service";
import { emailFlashReport, getFlashReport } from "../services/accountant/reporting.service";
import {
  postFlashReportToSlack,
  exportFlashReportToNotion,
  importInvoicesFromNotion,
} from "../services/accountant/integrations.service";
import {
  chat,
  command,
  executeAction,
  getChatHistory,
  getConversationMessages,
  listConversations,
} from "../services/accountant/assistant.service";
import { transcribeAudio } from "../services/ai/multimodal.service";
import {
  listContractors,
  needsW9,
  seedDemoContractors,
  sendW9Request,
  setContractorStatus,
  type W9Status,
} from "../services/accountant/tax.service";
import {
  getAutomations,
  listClientSettings,
  setClientDunningPaused,
  updateAutomation,
  type AutomationType,
  type AutonomyLevel,
} from "../services/accountant/automations.service";
import {
  listActivity,
  setActivityStatus,
} from "../services/accountant/activity.service";
import {
  approveSuggestedActivity,
  runAutomationsForUser,
} from "../services/accountant/automationRunner.service";
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

// Manual invoice creation (entered in the app).
const CreateInvoiceBody = z.object({
  clientName: z.string().min(1).max(200),
  clientEmail: z.string().email().optional(),
  amountCents: z.number().int().positive(),
  dueDate: z.string().optional(),
  invoiceNumber: z.string().max(60).optional(),
  currency: z.string().max(8).optional(),
});
router.post("/invoices", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CreateInvoiceBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("clientName and amountCents are required.");
    res.json({ invoice: await createInvoice(user.id, parsed.data) });
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

// Manual expense creation (entered in the app).
const CreateExpenseBody = z.object({
  merchant: z.string().min(1).max(200),
  amountCents: z.number().int().positive(),
  currency: z.string().max(8).optional(),
  txnDate: z.string().optional(),
  category: z.string().max(80).optional(),
});
router.post("/expenses", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CreateExpenseBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("merchant and amountCents are required.");
    res.json({ expense: await createExpenseManual(user.id, parsed.data) });
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

// Receipt photo → Gemini vision → create a pending expense for review.
const ScanReceiptBody = z.object({
  imageBase64: z.string().min(1),
  mimeType: z.string().optional(),
});
router.post("/expenses/scan-receipt", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ScanReceiptBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("imageBase64 is required.");
    const { receipt, isFallback } = await extractReceipt(
      parsed.data.imageBase64,
      parsed.data.mimeType,
    );
    const expense = await createExpenseFromReceipt(user.id, {
      merchant: receipt.merchant,
      amountCents: receipt.amountCents,
      currency: receipt.currency,
      txnDate: receipt.txnDate,
      category: receipt.category,
    });
    res.json({ expense, isFallback });
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

// Push the flash report to a Slack channel (gated on Slack being connected).
const FlashSlackBody = z.object({ channel: z.string().optional() });
router.post("/reports/flash/slack", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = FlashSlackBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid request body.");
    res.json(await postFlashReportToSlack(user, parsed.data.channel));
  } catch (err) {
    next(err);
  }
});

// Export the flash report to a Notion page (gated on Notion being connected).
const FlashNotionBody = z.object({ parentId: z.string().optional() });
router.post("/reports/flash/notion", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = FlashNotionBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid request body.");
    res.json(await exportFlashReportToNotion(user, parsed.data.parentId));
  } catch (err) {
    next(err);
  }
});

// Pull invoices from a Notion database (gated on Notion being connected).
const ImportNotionBody = z.object({ databaseId: z.string().min(1) });
router.post("/invoices/import/notion", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ImportNotionBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("databaseId is required.");
    const result = await importInvoicesFromNotion(user, parsed.data.databaseId);
    res.json({ ...result, invoices: await listInvoices(user.id) });
  } catch (err) {
    next(err);
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

// Conversation history (hamburger menu) — list threads + fetch one thread.
router.get("/assistant/conversations", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json({ conversations: await listConversations(user.id) });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/assistant/conversations/:id/messages",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      res.json({ messages: await getConversationMessages(user.id, req.params.id) });
    } catch (err) {
      next(err);
    }
  },
);

// Agentic command center — plan an action (or answer) from a natural-language command.
const CommandBody = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
  attachmentBase64: z.string().min(1).optional(),
  attachmentMimeType: z.string().min(1).optional(),
});
router.post("/assistant/command", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CommandBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("message is required.");
    const attachment = parsed.data.attachmentBase64
      ? { data: parsed.data.attachmentBase64, mimeType: parsed.data.attachmentMimeType ?? "application/octet-stream" }
      : undefined;
    res.json(await command(user.id, parsed.data.message, parsed.data.conversationId, attachment));
  } catch (err) {
    next(err);
  }
});

// Execute a user-confirmed action.
const ExecuteBody = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});
router.post("/assistant/execute", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ExecuteBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("name is required.");
    res.json(await executeAction(user, parsed.data.name, parsed.data.args ?? {}));
  } catch (err) {
    mapSendError(err, next);
  }
});

// Voice → text (Gemini audio transcription) for the command bar.
const TranscribeBody = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().optional(),
});
router.post("/assistant/transcribe", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = TranscribeBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("audioBase64 is required.");
    const result = await transcribeAudio(parsed.data.audioBase64, parsed.data.mimeType);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Automations + autonomy ───────────────────────────────────────────────────
const AUTOMATION_TYPES: AutomationType[] = [
  "dunning_sequence",
  "expense_audit",
  "flash_report",
  "tax_docs",
];

router.get("/automations", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json({
      automations: await getAutomations(user.id),
      clientSettings: await listClientSettings(user.id),
    });
  } catch (err) {
    next(err);
  }
});

const UpdateAutomationBody = z.object({
  enabled: z.boolean().optional(),
  autonomy: z.enum(["off", "suggest", "auto"]).optional(),
  config: z.record(z.unknown()).optional(),
  guardrails: z.record(z.unknown()).optional(),
});
router.put("/automations/:type", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const type = req.params.type as AutomationType;
    if (!AUTOMATION_TYPES.includes(type)) throw new BadRequestError("Unknown automation type.");
    const parsed = UpdateAutomationBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid request body.");
    res.json({ automation: await updateAutomation(user.id, type, parsed.data as { autonomy?: AutonomyLevel }) });
  } catch (err) {
    next(err);
  }
});

const ClientDunningBody = z.object({ paused: z.boolean() });
router.put("/clients/:clientName/dunning", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = ClientDunningBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("paused (boolean) is required.");
    await setClientDunningPaused(user.id, req.params.clientName, parsed.data.paused);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Agent activity feed ──────────────────────────────────────────────────────
router.get("/activity", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json({ activity: await listActivity(user.id) });
  } catch (err) {
    next(err);
  }
});

router.post("/activity/:id/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const result = await approveSuggestedActivity(user, req.params.id);
    res.json(result);
  } catch (err) {
    mapSendError(err, next);
  }
});

router.post("/activity/:id/dismiss", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    await setActivityStatus(user.id, req.params.id, "dismissed");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Run the user's due automations now (testing; QStash schedule hits the worker route).
router.post("/automations/run-now", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json(await runAutomationsForUser(user));
  } catch (err) {
    mapSendError(err, next);
  }
});

// ─── Tax Document Gathering ───────────────────────────────────────────────────
router.get("/tax/contractors", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const contractors = await listContractors(user.id);
    res.json({ contractors: contractors.map((c) => ({ ...c, needsW9: needsW9(c) })) });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/tax/contractors/:id/request-w9",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      res.json(await sendW9Request(user, req.params.id));
    } catch (err) {
      mapSendError(err, next);
    }
  },
);

const ContractorStatusBody = z.object({
  status: z.enum(["missing", "requested", "received", "filed"]),
});
router.post(
  "/tax/contractors/:id/status",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const parsed = ContractorStatusBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new BadRequestError("Invalid status.");
      await setContractorStatus(user.id, req.params.id, parsed.data.status as W9Status);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

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
    const insertedContractors = await seedDemoContractors(user.id);
    res.json({
      insertedInvoices,
      insertedExpenses,
      insertedContractors,
      invoices: await listInvoices(user.id),
      expenses: await listExpenses(user.id),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
