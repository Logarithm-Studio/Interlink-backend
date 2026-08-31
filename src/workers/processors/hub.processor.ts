/**
 * Notification Hub worker — refreshes ONE source for ONE user.
 *
 * Dispatched by `dispatchExternalAdapters()`, one job per user per source, so a slow or
 * rate-limited provider affects only that user's job rather than a whole-fleet tick.
 *
 * Retry contract (see workers.routes.ts): an unknown source is a `PermanentJobError` → 422 →
 * QStash never retries, because retrying a typo cannot help. Anything else throws → 5xx →
 * QStash retries with backoff, which is correct for a transient Google outage.
 */

import { JobEnvelopeSchema } from "../../jobs/schemas/envelope";
import { PermanentJobError } from "../../jobs/errors";
import { logger } from "../../observability/logger";
import { runGmailAdapter } from "../../services/notifications/adapters/gmail.adapter";
import { runSlackAdapter } from "../../services/notifications/adapters/slack.adapter";
import { runGithubAdapter } from "../../services/notifications/adapters/github.adapter";
import { runJiraAdapter } from "../../services/notifications/adapters/jira.adapter";

export async function processHubJob(body: unknown, jobId: string): Promise<void> {
  const parsed = JobEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new PermanentJobError(
      `Invalid hub job envelope: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    );
  }

  const { userId, payload } = parsed.data;
  const source = typeof payload.source === "string" ? payload.source : null;

  const adapters: Record<string, (userId: string) => Promise<number>> = {
    gmail: runGmailAdapter,
    slack: runSlackAdapter,
    github: runGithubAdapter,
    jira: runJiraAdapter,
  };

  const run = source ? adapters[source] : undefined;
  if (!run) {
    // A typo cannot be fixed by retrying, so this is permanent (422) rather than 5xx.
    throw new PermanentJobError(`Unknown hub source: ${String(source)}`);
  }

  const written = await run(userId);
  logger.info("[hub:worker] source refresh complete", { userId, jobId, source, written });
}
