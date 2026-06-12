/**
 * POST /api/v1/workflows/actions
 *
 * Allows authenticated users to resume a workflow execution that is waiting
 * for explicit user input (e.g. after a `wait_for_input` step sends a
 * notification with action buttons).
 *
 * Security notes:
 * - Authentication is enforced via standard `authMiddleware`.
 * - Step 17 will add HMAC signature verification on `token`.  Until then,
 *   only authenticated users can submit actions, and the action is validated
 *   against the execution's owner.
 * - The endpoint is idempotent: submitting the same
 *   (executionId, stepId, actionKey) twice is safe — BullMQ dedupe prevents
 *   a duplicate `workflow.resume` job from being enqueued, and the engine
 *   guards on step.status === 'completed'.
 */

import { randomUUID } from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { enqueueJob } from "../services/jobQueue.service";
import { JobType } from "../jobs/schemas/envelope";
import { AuthenticatedRequest } from "../types";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../utils/errors";
import { getExecution } from "../services/workflows.service";
import { recordAuditLog, buildEffectKey } from "../security/idempotency";
import { verifyActionToken, TokenError } from "../security/signedActions";
import { workflowActionRateLimit } from "../middleware/rateLimit";

const router = Router();

// ─── Request body schema ─────────────────────────────────────────────────────

const WorkflowActionBodySchema = z.object({
  /** UUID of the workflow_executions row to resume. */
  executionId: z.string().uuid(),
  /**
   * Step that is currently `waiting` and should be resumed.
   * The caller must know which step they are responding to (the notification
   * includes this value as part of the signed token — Step 17).
   */
  stepId: z.string().min(1),
  /**
   * Identifies which action the user took (matches a key in the notification's
   * `actions` array, e.g. `"keep_event_a"`).
   */
  actionKey: z.string().min(1),
  /**
   * Optional additional data provided by the user (e.g. a reschedule time
   * selected from a picker).
   */
  payload: z.record(z.unknown()).optional(),
  /**
   * Signed token (Step 17: HMAC-signed, includes nonce + expiry).
   * Accepted but not yet validated — signature verification added in Step 17.
   */
  token: z.string().optional(),
});

type WorkflowActionBody = z.infer<typeof WorkflowActionBodySchema>;

// ─── Route ───────────────────────────────────────────────────────────────────

router.post(
  "/actions",
  authMiddleware as never,
  workflowActionRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      // Parse + validate body.
      const parseResult = WorkflowActionBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new BadRequestError(
          `Invalid request body: ${parseResult.error.issues
            .map((i) => i.message)
            .join(", ")}`,
        );
      }
      const { payload, token } = parseResult.data as WorkflowActionBody;
      let { executionId, stepId, actionKey } =
        parseResult.data as WorkflowActionBody;

      // If a signed token is provided, verify it and use its payload as the
      // authoritative source for executionId / stepId / actionKey.  This prevents
      // callers from tampering with any of those fields.
      if (token) {
        try {
          const tokenPayload = await verifyActionToken(token);
          executionId = tokenPayload.executionId;
          stepId = tokenPayload.stepId;
          actionKey = tokenPayload.actionKey;
        } catch (err) {
          if (err instanceof TokenError) {
            throw new UnauthorizedError(`Invalid action token: ${err.message}`);
          }
          throw err;
        }
      }

      // Verify the execution exists and belongs to this user.
      const execution = await getExecution(executionId);
      if (!execution) {
        throw new NotFoundError(`Workflow execution ${executionId}`);
      }
      if (execution.userId !== user.id) {
        throw new UnauthorizedError(
          "You do not have access to this workflow execution",
        );
      }

      // Guard: must be in a waiting state.
      if (execution.status !== "waiting") {
        throw new BadRequestError(
          `Execution ${executionId} is not waiting for input (status: ${execution.status})`,
        );
      }

      // Deterministic jobId — prevents double-resume if the user submits twice.
      const jobId = `workflow|resume|${executionId}|${stepId}|${actionKey}`;

      await enqueueJob(
        "workflow",
        {
          jobType: JobType.WORKFLOW_RESUME,
          requestId: randomUUID(),
          idempotencyKey: jobId,
          userId: user.id,
          payload: {
            executionId,
            stepId,
            resumeKey: actionKey,
            resumePayload: payload ?? {},
          } as Record<string, unknown>,
        },
        { jobId, retries: 12 },
      );

      // Durable audit entry for this user action.
      await recordAuditLog({
        userId: user.id,
        actorType: "api",
        action: "workflow.action.submitted",
        entityType: "workflow_execution",
        entityId: executionId,
        idempotencyKey: buildEffectKey("workflow.action.submitted", jobId),
        payload: { executionId, stepId, actionKey },
      });

      res.status(202).json({
        message: "Action accepted — workflow will resume shortly",
        executionId,
        stepId,
        actionKey,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
