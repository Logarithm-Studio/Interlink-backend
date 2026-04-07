import dns from "dns";
import "dotenv/config";

// Force IPv4 — required on hosts without IPv6 routing
dns.setDefaultResultOrder("ipv4first");

import { initKeyring } from "./security/keyring";
import { logger } from "./observability/logger";
import { startAllWorkers } from "./workers";

// Initialise encryption key ring before processing any jobs that read tokens.
initKeyring();

const workers = startAllWorkers();

logger.info("Worker process started", { queues: workers.length });

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info("Shutdown signal received", { signal });
  await Promise.all(workers.map((w) => w.close()));
  logger.info("All workers closed — exiting");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Log unhandled rejections so they surface in structured logs.
process.on("unhandledRejection", (reason) => {
  logger.fatal("Unhandled promise rejection", {
    err: reason instanceof Error ? reason : new Error(String(reason)),
  } as Parameters<typeof logger.fatal>[1]);
});
