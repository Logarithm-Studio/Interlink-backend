import type { Worker } from "bullmq";
import { startCalendarSyncWorker } from "./processors/calendarSync.processor";
import { startTriggersWorker } from "./processors/triggers.processor";
import { startWorkflowWorker } from "./processors/workflow.processor";
import { startNotificationsWorker } from "./processors/notifications.processor";
import { startEmailWorker } from "./processors/email.processor";
import { startDlqWorker } from "./processors/dlq.processor";
import { startConflictsWorker } from "./processors/conflicts.processor";

/**
 * Start all queue workers and return them for graceful shutdown.
 */
export function startAllWorkers(): Worker[] {
  return [
    startCalendarSyncWorker(),
    startTriggersWorker(),
    startWorkflowWorker(),
    startNotificationsWorker(),
    startEmailWorker(),
    startDlqWorker(),
    startConflictsWorker(),
  ];
}
