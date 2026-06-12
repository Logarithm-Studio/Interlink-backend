// BullMQ removed — jobs are now dispatched via QStash (src/services/jobQueue.service.ts).
export function getConnection(): never {
  throw new Error("BullMQ has been removed. Use enqueueJob() from jobQueue.service.ts.");
}
