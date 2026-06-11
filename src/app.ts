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
  app.use(express.json());
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
}

function setupErrorHandling(app: Express) {
  // Global error handler (must be last)
  app.use(errorHandler);
}

export default app;
