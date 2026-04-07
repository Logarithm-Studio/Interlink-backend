/**
 * Audit service — structured logging + durable DB audit writes in one call.
 *
 * Every side-effecting operation (calendar mutation, email draft, notification,
 * AI generation, workflow state change) should call `audit()` so the action is:
 *   1. Written to the `audit_log` DB table (idempotent — UNIQUE on action + key).
 *   2. Emitted as a structured log line (info or error level).
 *
 * This is a thin wrapper around `recordAuditLog` from `idempotency.ts`.
 * The only addition is the co-located structured log write.
 *
 * Usage:
 *   import { audit } from '../services/audit.service';
 *
 *   await audit({
 *     log: req.log,                // or createWorkerLogger(...)
 *     userId: user.id,
 *     actorType: 'api',
 *     action: 'workflow.action.submitted',
 *     entityType: 'workflow_execution',
 *     entityId: executionId,
 *     idempotencyKey: jobId,
 *     requestId: req.requestId,
 *     payload: { stepId, actionKey },
 *   });
 *
 * Security: the `payload` field must NEVER include tokens, passwords, or raw
 * provider credentials.  Scrub sensitive fields before calling this function.
 */

import { recordAuditLog, AuditLogEntry } from "../security/idempotency";
import { logger as rootLogger, Logger } from "../observability/logger";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AuditParams extends AuditLogEntry {
  /**
   * Structured logger to use for the log line.
   * Defaults to the root logger if not provided.
   */
  log?: Logger;
}

// ─── audit() ─────────────────────────────────────────────────────────────────

/**
 * Write a durable audit log entry and emit a structured log line.
 *
 * Returns `true` if the row was new (first call for this idempotency key),
 * `false` if it was a duplicate (idempotent no-op).
 */
export async function audit(params: AuditParams): Promise<boolean> {
  const { log: boundLog, ...entry } = params;
  const log = boundLog ?? rootLogger;

  // DB write (idempotent).
  let isNew: boolean;
  try {
    isNew = await recordAuditLog(entry);
  } catch (err) {
    log.error("audit_log write failed", {
      action: entry.action,
      idempotencyKey: entry.idempotencyKey ?? undefined,
      err: err instanceof Error ? err : new Error(String(err)),
    } as Parameters<Logger["error"]>[1]);
    return false;
  }

  // Structured log.
  const logPayload: Record<string, unknown> = {
    action: entry.action,
    actorType: entry.actorType,
    entityType: entry.entityType ?? undefined,
    entityId: entry.entityId ?? undefined,
    idempotencyKey: entry.idempotencyKey ?? undefined,
    requestId: entry.requestId ?? undefined,
    duplicate: !isNew,
  };

  if (isNew) {
    log.info(`[audit] ${entry.action}`, logPayload);
  } else {
    log.debug(`[audit] duplicate — skipped ${entry.action}`, logPayload);
  }

  return isNew;
}

// ─── createAuditContext() ─────────────────────────────────────────────────────

/**
 * Returns a partially-applied `audit` function with fixed context fields
 * (e.g. requestId, executionId, userId) already bound in.
 *
 * Useful in request handlers and workers:
 *
 *   const auditCtx = createAuditContext({
 *     log: req.log,
 *     requestId: req.requestId,
 *     userId: req.user.id,
 *     actorType: 'api',
 *   });
 *
 *   await auditCtx('workflow.action.submitted', {
 *     entityId: executionId,
 *     idempotencyKey: jobId,
 *     payload: { stepId },
 *   });
 */
export type AuditContextFn = (
  action: string,
  extra?: Omit<AuditParams, "action" | "actorType" | "userId" | "log">,
) => Promise<boolean>;

export function createAuditContext(base: {
  log?: Logger;
  userId?: string | null;
  actorType: "api" | "worker" | "system";
  requestId?: string;
}): AuditContextFn {
  return (action, extra = {}) =>
    audit({
      ...base,
      ...extra,
      action,
      userId: base.userId,
      requestId: base.requestId ?? extra.requestId,
    });
}

// ─── Re-exports for convenience ───────────────────────────────────────────────

// Callers that already imported from idempotency.ts can migrate to here
// without changing imports at many call sites.
export { recordAuditLog, AuditLogEntry } from "../security/idempotency";
