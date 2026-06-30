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

export default router;
