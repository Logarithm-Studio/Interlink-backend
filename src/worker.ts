// Workers are now QStash HTTP callbacks — this standalone process is no longer needed.
// Keep the file so `npm run worker:start` doesn't crash if called during migration.
import "dotenv/config";
import { logger } from "./observability/logger";

logger.info("Worker process is a no-op — jobs are handled by /api/v1/workers/* (QStash HTTP callbacks).");
