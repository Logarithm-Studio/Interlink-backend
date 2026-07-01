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
// Personal mode integrations
import personaRoutes from "./routes/persona.routes";
import spotifyRoutes from "./routes/spotify.routes";
import weatherRoutes from "./routes/weather.routes";
import tasksRoutes from "./routes/tasks.routes";
import todoistRoutes from "./routes/todoist.routes";
import notionRoutes from "./routes/notion.routes";
import fitnessRoutes from "./routes/fitness.routes";
import personalAssistantRoutes from "./routes/personal-assistant.routes";
// Professional mode personas
import pmRoutes from "./routes/pm.routes";
import hrRoutes from "./routes/hr.routes";
import professionalStubsRoutes from "./routes/professional-stubs.routes";
import professionalRoutes from "./routes/professional.routes";

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
  // Personal mode
  app.use("/api/v1", personaRoutes);
  app.use("/api/v1/spotify", spotifyRoutes);
  app.use("/api/v1/weather", weatherRoutes);
  app.use("/api/v1/tasks", tasksRoutes);
  app.use("/api/v1/todoist", todoistRoutes);
  app.use("/api/v1/notion", notionRoutes);
  app.use("/api/v1/fitness", fitnessRoutes);
  app.use("/api/v1/personal-assistant", personalAssistantRoutes);
  // Professional mode
  app.use("/api/v1/pm", pmRoutes);
  app.use("/api/v1/hr", hrRoutes);
  app.use("/api/v1/professional", professionalRoutes);
  app.use("/api/v1/professional", professionalStubsRoutes);
}

function setupErrorHandling(app: Express) {
  // Global error handler (must be last)
  app.use(errorHandler);
}

export default app;
