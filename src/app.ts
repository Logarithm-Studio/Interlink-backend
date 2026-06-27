import "dotenv/config";
import express, { Express, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { errorHandler } from "./utils/errors";
import { requestIdMiddleware } from "./middleware/requestId";
import { initKeyring } from "./security/keyring";

// Route imports
import authRoutes from "./routes/auth.routes";
import calendarRoutes from "./routes/calendar.routes";
import eventsRoutes from "./routes/events.routes";
import emailTemplatesRoutes from "./routes/emailTemplates.routes";
import preferencesRoutes from "./routes/preferences.routes";
import workflowsRoutes from "./routes/workflows.routes";
import workflowActionsRoutes from "./routes/workflow.actions.routes";
import googleRoutes from "./routes/google.routes";
import remindersRoutes from "./routes/reminders.routes";
import pushTokensRoutes from "./routes/pushTokens.routes";
import workersRoutes from "./routes/workers.routes";
import accountantRoutes from "./routes/accountant.routes";

const app: Express = express();

// Required in serverless runtimes that import app directly (without server.ts).
initKeyring();

configureMiddleware(app);
setupRoutes(app);
setupErrorHandling(app);

function configureMiddleware(app: Express) {
  // requestId must come first — attaches req.requestId and req.log used by all
  // subsequent middleware and route handlers.
  app.use(requestIdMiddleware);
  app.use(helmet());
  app.use(cors());
  // Capture raw body bytes so QStash signature verification in workers.routes.ts
  // can verify the Upstash-Signature header against the original payload bytes.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));
}

function setupRoutes(app: Express) {
  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // API v1 routes
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/calendar", calendarRoutes);
  app.use("/api/v1/events", eventsRoutes);
  app.use("/api/v1/preferences", preferencesRoutes);
  app.use("/api/v1/workflows", workflowsRoutes);
  app.use("/api/v1/workflows", workflowActionsRoutes);
  app.use("/api/v1/email-templates", emailTemplatesRoutes);
  app.use("/api/v1/google", googleRoutes);
  app.use("/api/v1/reminders", remindersRoutes);
  app.use("/api/v1/push-tokens", pushTokensRoutes);
  app.use("/api/v1/accountant", accountantRoutes);
  app.use("/api/v1/workers", workersRoutes);
}

function setupErrorHandling(app: Express) {
  // Global error handler (must be last)
  app.use(errorHandler);
}

export default app;
