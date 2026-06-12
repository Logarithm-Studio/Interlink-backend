// BullMQ queues removed — jobs are now dispatched via QStash (src/services/jobQueue.service.ts).
export function getCalendarSyncQueue(): never { throw new Error("Use enqueueJob()"); }
export function getTriggersQueue(): never { throw new Error("Use enqueueJob()"); }
export function getWorkflowQueue(): never { throw new Error("Use enqueueJob()"); }
export function getConflictsQueue(): never { throw new Error("Use enqueueJob()"); }
export function getNotificationsQueue(): never { throw new Error("Use enqueueJob()"); }
export function getEmailQueue(): never { throw new Error("Use enqueueJob()"); }
export function getDlqQueue(): never { throw new Error("Use enqueueJob()"); }
export function getAllQueues(): never[] { return []; }
