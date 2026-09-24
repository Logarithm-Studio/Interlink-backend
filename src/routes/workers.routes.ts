/**
 * /api/v1/workers/* — QStash callback endpoints.
 *
 * QStash POSTs job payloads here after publishing.  Each route verifies the
 * Upstash-Signature header, dispatches to the appropriate processor, and:
 *   - Returns 200 on success  → QStash marks the message delivered.
 *   - Returns 422 on PermanentJobError → QStash does NOT retry (4xx = permanent failure).
 *   - Returns 500 on transient errors  → QStash retries with exponential backoff.
 */

import { Router, Request, Response } from "express";
import { verifyQStash } from "../middleware/qstashVerify";
import { PermanentJobError } from "../jobs/errors";
import { processCalendarSyncJob } from "../workers/processors/calendarSync.processor";
import { processTriggersJob } from "../workers/processors/triggers.processor";
import { processWorkflowJob } from "../workers/processors/workflow.processor";
import { processConflictsJob } from "../workers/processors/conflicts.processor";
import { processNotificationsJob } from "../workers/processors/notifications.processor";
import { processEmailJob } from "../workers/processors/email.processor";
import { processDlqJob } from "../workers/processors/dlq.processor";
import { runDueAutomations } from "../services/accountant/automationRunner.service";
import { runDueProfessionalAutomations } from "../services/professional/automationRunner";
import { runDailyDigestForAllUsers } from "../services/notifications/dailyDigest.service";
import { runHubRetention } from "../services/notifications/hubRetention.service";
import {
  runInternalAdapterForAllUsers,
  dispatchExternalAdapters,
} from "../services/notifications/hubScheduler.service";
import { processHubJob } from "../workers/processors/hub.processor";
import { processMarketingTodoistSyncJob } from "../workers/processors/marketingTodoist.processor";
import { processMarketingFollowupReminderJob } from "../workers/processors/marketingFollowupReminder.processor";
import { dispatchMarketingFollowupReminderUsers, dispatchStaleMarketingTodoistSyncs } from "../services/professional/marketing/leads.service";
import { dispatchMarketingAnalyticsRefreshes } from "../services/professional/marketing/analytics-schedule.service";
import { processMarketingAnalyticsRefreshJob } from "../workers/processors/marketingAnalyticsRefresh.processor";
import { processMarketingPostMonitorJob } from "../workers/processors/marketingPostMonitor.processor";
import { dispatchMarketingPostMonitoring } from "../services/professional/marketing/post-monitoring-schedule.service";
import { dispatchMarketingHubSpotMonitoring } from "../services/professional/marketing/hubspot-monitoring.service";
import { processMarketingHubSpotMonitorJob } from "../workers/processors/marketingHubSpotMonitor.processor";
import { processMarketingSocialPublishJob } from "../workers/processors/marketingSocialPublish.processor";
import { dispatchMarketingSocialPublishSchedules } from "../services/professional/marketing/social-scheduling.service";

const router = Router();

// All worker endpoints require a valid QStash signature.
router.use(verifyQStash);

function getJobId(req: Request): string {
  const id = req.headers["upstash-message-id"];
  return (Array.isArray(id) ? id[0] : id) ?? "unknown";
}

async function runWorker(
  res: Response,
  handler: (body: unknown, jobId: string) => Promise<void>,
  body: unknown,
  jobId: string,
): Promise<void> {
  try {
    await handler(body, jobId);
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof PermanentJobError) {
      // 4xx tells QStash not to retry.
      res.status(422).json({ error: err.message });
      return;
    }
    // 5xx tells QStash to retry.
    console.error(`[workers] job ${jobId} failed (will retry):`, err);
    res.status(500).json({ error: "Job failed — will be retried" });
  }
}

router.post("/calendar-sync", (req, res) => {
  void runWorker(res, processCalendarSyncJob, req.body, getJobId(req));
});

router.post("/triggers", (req, res) => {
  void runWorker(res, processTriggersJob, req.body, getJobId(req));
});

router.post("/workflow", (req, res) => {
  void runWorker(res, processWorkflowJob, req.body, getJobId(req));
});

router.post("/conflicts", (req, res) => {
  void runWorker(res, processConflictsJob, req.body, getJobId(req));
});

router.post("/notifications", (req, res) => {
  void runWorker(res, processNotificationsJob, req.body, getJobId(req));
});

router.post("/email", (req, res) => {
  void runWorker(res, processEmailJob, req.body, getJobId(req));
});

router.post("/dlq", (req, res) => {
  void runWorker(res, processDlqJob, req.body, getJobId(req));
});

// Professional Mode (Accountant) — scheduled autonomy tick (QStash Schedule, daily).
router.post("/accountant-automations", (req, res) => {
  void runWorker(
    res,
    async () => {
      await runDueAutomations();
    },
    req.body,
    getJobId(req),
  );
});

// Professional Mode (Sales/Support/HR/Real Estate/PM) — scheduled autonomy tick.
router.post("/professional-automations", (req, res) => {
  void runWorker(
    res,
    async () => {
      await runDueProfessionalAutomations();
    },
    req.body,
    getJobId(req),
  );
});

// Notification Hub — refresh internal signals for every user (QStash Schedule, hourly).
// Internal signals are pure SQL over tables we already own, so a single tick is safe here.
// External adapters (Gmail, Slack, GitHub) must fan out one job per user per source instead.
router.post("/hub-refresh", (req, res) => {
  void runWorker(
    res,
    async () => {
      // Internal signals inline (pure SQL, no rate limits), then fan out one job per user
      // per external source so a slow provider never stalls the whole fleet.
      await runInternalAdapterForAllUsers();
      await dispatchExternalAdapters();
    },
    req.body,
    getJobId(req),
  );
});

// One source, one user — dispatched by /hub-refresh.
router.post("/hub", (req, res) => {
  void runWorker(res, processHubJob, req.body, getJobId(req));
});

// Notification Hub — tiered retention sweep (QStash Schedule, daily).
// Deletes resolved items at 7d, strips preview text from still-open items at 7d (the row
// survives as a pointer), and drops anything still open at 30d. State-based, not age-based:
// an invoice overdue 30 days is exactly what the hub is meant to keep holding.
router.post("/hub-retention", (req, res) => {
  void runWorker(
    res,
    async () => {
      await runHubRetention();
    },
    req.body,
    getJobId(req),
  );
});

// Daily digest push — the "come back to Interlink" notification (QStash Schedule, daily).
// Sends at most one push per user per day, and nothing at all when the user has nothing
// pending. See services/notifications/dailyDigest.service.ts.
router.post("/daily-digest", (req, res) => {
  void runWorker(
    res,
    async () => {
      await runDailyDigestForAllUsers();
    },
    req.body,
    getJobId(req),
  );
});

// Marketing hourly QStash Schedule for Todoist reconciliation, HubSpot checks, and follow-up reminders.
router.post("/marketing-todoist-dispatch", (req, res) => {
  void runWorker(
    res,
    async () => { await Promise.all([dispatchStaleMarketingTodoistSyncs(), dispatchMarketingFollowupReminderUsers(), dispatchMarketingHubSpotMonitoring(), dispatchMarketingSocialPublishSchedules()]); },
    req.body,
    getJobId(req),
  );
});

// One delayed, user-scoped provider write for an explicitly scheduled and approved post.
router.post("/marketing-social-publish", (req, res) => {
  void runWorker(res, processMarketingSocialPublishJob, req.body, getJobId(req));
});

// One user's opt-in HubSpot mapped-deal polling job; provider values are never imported automatically.
router.post("/marketing-hubspot-monitor", (req, res) => {
  void runWorker(res, processMarketingHubSpotMonitorJob, req.body, getJobId(req));
});

// One user's mapped Marketing follow-ups — isolated so provider delays/retries do not stall a fleet tick.
router.post("/marketing-todoist-sync", (req, res) => {
  void runWorker(res, processMarketingTodoistSyncJob, req.body, getJobId(req));
});

// One user's bounded marketing reminder delivery pass; external sends are independently claimed per channel.
router.post("/marketing-followup-reminder", (req, res) => {
  void runWorker(res, processMarketingFollowupReminderJob, req.body, getJobId(req));
});

// Marketing read-only provider snapshots — daily fan-out, then isolated per-user refresh jobs.
router.post("/marketing-analytics-dispatch", (req, res) => {
  void runWorker(
    res,
    async () => { await Promise.all([dispatchMarketingAnalyticsRefreshes(), dispatchMarketingPostMonitoring()]); },
    req.body,
    getJobId(req),
  );
});

router.post("/marketing-analytics-refresh", (req, res) => {
  void runWorker(res, processMarketingAnalyticsRefreshJob, req.body, getJobId(req));
});

router.post("/marketing-post-monitor", (req, res) => {
  void runWorker(res, processMarketingPostMonitorJob, req.body, getJobId(req));
});

export default router;
