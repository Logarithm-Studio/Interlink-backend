/**
 * /api/v1/accountant/* — Professional Mode (Accountant) endpoints.
 *
 * Iteration 1 covers the "Dunning & Invoice Reminders" workflow end-to-end over
 * seeded invoice data. The interactive send mirrors the Personal-Mode decline
 * flow (`events/:id/send-decline-email`): synchronous, returns the sent email so
 * the app's InterlinkWorkingModal can gate on the response.
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
import { AuthError, sendInvoiceReminder } from "../services/accountant/dunning.service";
import { sendPushNotification } from "../services/notifications/push.service";

const router = Router();

router.use(authMiddleware as never);

const STATUSES: InvoiceStatus[] = ["open", "overdue", "reminded", "paid"];

// ─── GET /invoices ──────────────────────────────────────────────────────────
router.get("/invoices", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const statusParam = req.query.status as string | undefined;
    const status =
      statusParam && STATUSES.includes(statusParam as InvoiceStatus)
        ? (statusParam as InvoiceStatus)
        : undefined;
    const invoices = await listInvoices(user.id, { status });
    res.json({ invoices });
  } catch (err) {
    next(err);
  }
});

// ─── GET /invoices/:id ──────────────────────────────────────────────────────
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

// ─── POST /invoices/:id/send-reminder ───────────────────────────────────────
router.post(
  "/invoices/:id/send-reminder",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const result = await sendInvoiceReminder({ user, invoiceId: req.params.id });
      res.json(result);
    } catch (err) {
      if (err instanceof AuthError) {
        return next(
          new UnauthorizedError(
            "Google account needs to be reconnected before sending email.",
          ),
        );
      }
      next(err);
    }
  },
);

// ─── GET /invoices/:id/reminder-logs ────────────────────────────────────────
router.get(
  "/invoices/:id/reminder-logs",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const invoice = await getInvoiceById(user.id, req.params.id);
      if (!invoice) throw new NotFoundError("Invoice");
      const logs = await getReminderLogs(user.id, req.params.id);
      res.json({ logs });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /scan ─────────────────────────────────────────────────────────────
// Transition open→overdue past due date and notify the user. Runs on demand for
// testing; QStash Schedule calls this weekly in production.
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

// ─── POST /seed-demo ────────────────────────────────────────────────────────
const SeedBodySchema = z.object({
  clientEmail: z.string().email().optional(),
});

router.post("/seed-demo", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = SeedBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new BadRequestError("Invalid request body: clientEmail must be a valid email.");
    }
    // Default demo invoices to the user's own email so reminder sends are verifiable.
    const clientEmail = parsed.data.clientEmail ?? user.email;
    const inserted = await seedDemoInvoices(user.id, clientEmail);
    const invoices = await listInvoices(user.id);
    res.json({ inserted, invoices });
  } catch (err) {
    next(err);
  }
});

export default router;
