/**
 * Workflow execution routes.
 *
 * Users need visibility into their active and past workflow executions
 * (e.g. "a conflict was detected and we're waiting for your input").
 *
 * Routes:
 *   GET  /api/v1/workflows/executions          — List executions for the user
 *   GET  /api/v1/workflows/executions/:id       — Get execution details + steps
 */

import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { query } from "../config/db";
import { NotFoundError } from "../utils/errors";

const router = Router();

// All routes require authentication
router.use(authMiddleware as never);

// ─── GET /api/v1/workflows/executions ───────────────────────────────
// List workflow executions for the authenticated user.
// Optional ?status= filter (pending, running, waiting, completed, failed).
// Optional ?limit= and ?offset= for pagination (default: 20, max: 100).
router.get(
  "/executions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const status = req.query.status as string | undefined;
      const limit = Math.min(
        Math.max(parseInt(req.query.limit as string, 10) || 20, 1),
        100,
      );
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

      const params: unknown[] = [user.id, limit, offset];
      let statusClause = "";
      if (
        status &&
        ["pending", "running", "waiting", "completed", "failed"].includes(
          status,
        )
      ) {
        statusClause = "AND we.status = $4";
        params.push(status);
      }

      const result = await query<{
        id: string;
        workflow_id: string;
        workflow_name: string;
        status: string;
        current_step: string | null;
        context: Record<string, unknown>;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT we.id, we.workflow_id, w.name AS workflow_name,
                we.status, we.current_step, we.context,
                we.created_at, we.updated_at
         FROM workflow_executions we
         JOIN workflows w ON w.id = we.workflow_id
         WHERE we.user_id = $1 ${statusClause}
         ORDER BY we.updated_at DESC
         LIMIT $2 OFFSET $3`,
        params,
      );

      // Total count for pagination.
      const countParams: unknown[] = [user.id];
      let countStatusClause = "";
      if (
        status &&
        ["pending", "running", "waiting", "completed", "failed"].includes(
          status,
        )
      ) {
        countStatusClause = "AND status = $2";
        countParams.push(status);
      }
      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM workflow_executions
         WHERE user_id = $1 ${countStatusClause}`,
        countParams,
      );

      res.json({
        executions: result.rows.map((r) => ({
          id: r.id,
          workflowId: r.workflow_id,
          workflowName: r.workflow_name,
          status: r.status,
          currentStep: r.current_step,
          // Only include a summary of context (conflict info), not the full blob.
          summary: buildExecutionSummary(r.context),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
        total: parseInt(countResult.rows[0].count, 10),
        limit,
        offset,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/workflows/executions/:id ───────────────────────────
// Get full details for a single execution including step states.
router.get(
  "/executions/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const executionId = req.params.id;

      // Execution row.
      const execResult = await query<{
        id: string;
        workflow_id: string;
        status: string;
        context: Record<string, unknown>;
        current_step: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, workflow_id, status, context, current_step, created_at, updated_at
         FROM workflow_executions
         WHERE id = $1 AND user_id = $2`,
        [executionId, user.id],
      );

      if (execResult.rows.length === 0) {
        throw new NotFoundError("Workflow execution");
      }

      const exec = execResult.rows[0];

      // Workflow metadata.
      const wfResult = await query<{ name: string; trigger_type: string }>(
        `SELECT name, trigger_type FROM workflows WHERE id = $1`,
        [exec.workflow_id],
      );
      const workflow = wfResult.rows[0];

      // Step rows.
      const stepsResult = await query<{
        step_id: string;
        status: string;
        attempt: number;
        input: Record<string, unknown>;
        output: Record<string, unknown>;
        error: Record<string, unknown> | null;
        started_at: Date | null;
        finished_at: Date | null;
        next_run_at: Date | null;
      }>(
        `SELECT step_id, status, attempt, input, output, error,
                started_at, finished_at, next_run_at
         FROM workflow_execution_steps
         WHERE execution_id = $1
         ORDER BY started_at ASC NULLS LAST`,
        [executionId],
      );

      res.json({
        execution: {
          id: exec.id,
          workflowId: exec.workflow_id,
          workflowName: workflow?.name ?? "Unknown",
          triggerType: workflow?.trigger_type ?? null,
          status: exec.status,
          currentStep: exec.current_step,
          context: sanitizeContext(exec.context),
          createdAt: exec.created_at,
          updatedAt: exec.updated_at,
        },
        steps: stepsResult.rows.map((s) => ({
          stepId: s.step_id,
          status: s.status,
          attempt: s.attempt,
          output: s.output,
          error: s.error,
          startedAt: s.started_at,
          finishedAt: s.finished_at,
          nextRunAt: s.next_run_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Build a concise human-readable summary from execution context
 * for the list view (avoids sending full context blobs).
 */
function buildExecutionSummary(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  // Extract conflict details if present.
  const trigger = context.trigger as Record<string, unknown> | undefined;
  if (trigger?.triggerType) {
    summary.triggerType = trigger.triggerType;
  }

  const conflict = (trigger?.conflict ?? context.conflict) as
    | Record<string, unknown>
    | undefined;
  if (conflict) {
    summary.conflictType = conflict.conflictType;
    summary.severity = conflict.severity;
    const details = conflict.conflictingEventDetails as
      | Array<Record<string, unknown>>
      | undefined;
    if (details) {
      summary.conflictingEvents = details.map((d) => ({
        title: d.title,
        startTime: d.startTime ?? d.start_time,
        endTime: d.endTime ?? d.end_time,
      }));
    }
  }

  return summary;
}

/**
 * Remove sensitive fields from context before sending to clients.
 */
function sanitizeContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = { ...context };
  // Remove internal fields that shouldn't be exposed.
  delete sanitized._internal;
  delete sanitized.accessToken;
  delete sanitized.refreshToken;
  return sanitized;
}

export default router;
