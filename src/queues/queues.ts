import { Queue } from "bullmq";
import { getConnection } from "./connection";

// Lazily instantiated — queues are created on first access so that
// getConnection() is only called after dotenv.config() has run.
let _calendarSyncQueue: Queue | null = null;
let _triggersQueue: Queue | null = null;
let _workflowQueue: Queue | null = null;
let _conflictsQueue: Queue | null = null;
let _notificationsQueue: Queue | null = null;
let _emailQueue: Queue | null = null;
let _dlqQueue: Queue | null = null;

/** Calendar sync: Google and Microsoft webhook-driven sync and channel/subscription renewal. */
export function getCalendarSyncQueue(): Queue {
  return (_calendarSyncQueue ??= new Queue("calendar-sync", {
    connection: getConnection(),
  }));
}

/** Triggers: emit calendar events into the workflow trigger pipeline. */
export function getTriggersQueue(): Queue {
  return (_triggersQueue ??= new Queue("triggers", {
    connection: getConnection(),
  }));
}

/** Workflow: run, resume, and timeout workflow executions. */
export function getWorkflowQueue(): Queue {
  return (_workflowQueue ??= new Queue("workflow", {
    connection: getConnection(),
  }));
}

/** Conflicts: detect scheduling conflicts and emit conflict triggers. */
export function getConflictsQueue(): Queue {
  return (_conflictsQueue ??= new Queue("conflicts", {
    connection: getConnection(),
  }));
}

/** Notifications: push + email fallback delivery. */
export function getNotificationsQueue(): Queue {
  return (_notificationsQueue ??= new Queue("notifications", {
    connection: getConnection(),
  }));
}

/** Email: create drafts in Gmail / Outlook (never auto-send). */
export function getEmailQueue(): Queue {
  return (_emailQueue ??= new Queue("email", { connection: getConnection() }));
}

/** Dead-letter queue: receives jobs after all retries are exhausted. */
export function getDlqQueue(): Queue {
  return (_dlqQueue ??= new Queue("dlq", { connection: getConnection() }));
}

export function getAllQueues(): Queue[] {
  return [
    getCalendarSyncQueue(),
    getTriggersQueue(),
    getWorkflowQueue(),
    getConflictsQueue(),
    getNotificationsQueue(),
    getEmailQueue(),
    getDlqQueue(),
  ];
}
