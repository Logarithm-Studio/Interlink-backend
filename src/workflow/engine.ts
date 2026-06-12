/**
 * Workflow engine — the core runner that executes a single workflow step
 * and advances the execution state machine.
 *
 * Design constraints:
 * ─ A completed step is NEVER re-executed.  Guards at the top of `runStep`
 *   detect this and return early (idempotent for BullMQ retries).
 * ─ State transitions use compare-and-swap patterns via `src/workflow/state.ts`
 *   to prevent concurrent runners from double-executing a step.
 * ─ Context is append-only: outputs are written into
 *   `execution.context.outputs[stepId]`, never replacing existing keys.
 * ─ Step handlers are invoked via the registry; side effects happen inside
 *   handler implementations, each of which enforces its own idempotency.
 */

import { randomUUID } from "crypto";
import { enqueueJob } from "../services/jobQueue.service";
import { JobType } from "../jobs/schemas/envelope";
import {
  getExecution,
  getWorkflow,
  getStep,
} from "../services/workflows.service";
import { getHandler } from "./registry";
import {
  claimExecutionPending,
  markExecutionFailed,
  markStepRunning,
  markStepFailed,
  atomicStepCompletion,
} from "./state";
import { recordAuditLog, buildEffectKey } from "../security/idempotency";
import { AnyWorkflowStep } from "./definition";

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when an execution is not in the expected state (e.g. already
 * completed or failed).  The processor treats this as a clean exit.
 */
export class ExecutionStateError extends Error {
  constructor(
    public readonly executionId: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionStateError";
  }
}

/**
 * Thrown when a step type has no registered handler.
 * This is a permanent failure — retrying will not help.
 */
export class UnregisteredStepTypeError extends Error {
  constructor(public readonly stepType: string) {
    super(`No handler registered for step type: ${stepType}`);
    this.name = "UnregisteredStepTypeError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return the index of `stepId` within the `steps` array.
 * Returns -1 if not found.
 */
function findStepIndex(steps: AnyWorkflowStep[], stepId: string): number {
  return steps.findIndex((s) => s.id === stepId);
}

/**
 * Return the next step id after `stepId` in the linear progression.
 * Returns `null` if `stepId` is the last step or not found.
 */
function nextStepAfter(
  steps: AnyWorkflowStep[],
  stepId: string,
): string | null {
  const idx = findStepIndex(steps, stepId);
  if (idx < 0 || idx >= steps.length - 1) return null;
  return steps[idx + 1].id;
}

// ─── Core runner ──────────────────────────────────────────────────────────────

export interface RunStepOptions {
  executionId: string;
  stepId: string;
  /** Zero-based retry count (0 = first attempt). */
  attempt: number;
  userId: string;
  /** Idempotency key of the parent BullMQ job (for audit log). */
  jobIdempotencyKey: string;
  /** Request ID of the parent BullMQ job (for audit log). */
  requestId: string;
  /**
   * Additional input provided when resuming from a wait state.
   * Exposed to the handler via `ctx.resumePayload`.
   */
  resumePayload?: Record<string, unknown>;
}

/**
 * Execute a single workflow step, persist results, and advance the execution.
 *
 * This function is safe to call multiple times for the same (executionId, stepId):
 * - If the step is already `completed`, it returns immediately.
 * - If the execution is already `completed` or `failed`, it returns immediately.
 *
 * Throws `ExecutionStateError` for clean exits (processor should not DLQ these).
 * Throws `UnregisteredStepTypeError` for permanent failures (no retry benefit).
 * All other errors are retryable — the processor re-throws to BullMQ.
 */
export async function runStep(opts: RunStepOptions): Promise<void> {
  const {
    executionId,
    stepId,
    attempt,
    userId,
    jobIdempotencyKey,
    requestId,
    resumePayload,
  } = opts;

  // ── 1. Load execution ──────────────────────────────────────────────────────
  const execution = await getExecution(executionId);
  if (!execution) {
    throw new ExecutionStateError(
      executionId,
      `Execution ${executionId} not found`,
    );
  }
  if (execution.status === "completed" || execution.status === "failed") {
    console.log(
      `[engine] Execution ${executionId} already ${execution.status} — skipping step ${stepId}`,
    );
    return;
  }

  // ── 2. Load and guard step ─────────────────────────────────────────────────
  const stepRow = await getStep(executionId, stepId);
  if (stepRow?.status === "completed") {
    console.log(
      `[engine] Step ${stepId} already completed — skipping (idempotent)`,
    );
    return;
  }

  // ── 3. Load workflow definition ────────────────────────────────────────────
  const workflow = await getWorkflow(execution.workflowId);
  if (!workflow) {
    throw new ExecutionStateError(
      executionId,
      `Workflow ${execution.workflowId} not found for execution ${executionId}`,
    );
  }
  const { steps } = workflow.definition;

  // ── 4. Find this step's definition ────────────────────────────────────────
  const stepDef = steps.find((s) => s.id === stepId);
  if (!stepDef) {
    throw new ExecutionStateError(
      executionId,
      `Step definition "${stepId}" not found in workflow ${workflow.id}`,
    );
  }

  // ── 5. Ensure a handler is registered ────────────────────────────────────
  const handler = getHandler(stepDef.type);
  if (!handler) {
    throw new UnregisteredStepTypeError(stepDef.type);
  }

  // ── 6. Transition execution to 'running' if it is still 'pending' ─────────
  if (execution.status === "pending") {
    const claimed = await claimExecutionPending(executionId, stepId);
    if (!claimed) {
      // Another worker already claimed it — that's fine; we're in the same step.
      console.log(
        `[engine] Execution ${executionId} was already claimed — continuing`,
      );
    }
  }
  // If execution.status === 'running', another job may be running a different
  // step concurrently. Normally BullMQ jobId dedup prevents this, but we
  // proceed defensively.

  // ── 7. Mark step as 'running' (upsert) ────────────────────────────────────
  const stepInput: Record<string, unknown> = {
    triggerContext: execution.context["trigger"] ?? {},
    ...(resumePayload ? { resumePayload } : {}),
  };
  await markStepRunning(executionId, stepId, attempt, stepInput);

  // ── 8. Execute handler ─────────────────────────────────────────────────────
  let result;
  try {
    result = await handler({
      executionId,
      stepId,
      stepDefinition: stepDef,
      executionContext: execution.context,
      attempt,
      userId,
      resumePayload,
    });
  } catch (handlerError) {
    // Mark step as failed; re-throw so BullMQ retries.
    await markStepFailed(executionId, stepId, handlerError).catch(
      console.error,
    );
    throw handlerError;
  }

  // ── 9–12. Atomically persist output and advance execution ─────────────────
  // All three DB writes (step completed, context append, execution advance)
  // happen inside a single Postgres transaction so a mid-flight crash can never
  // leave the context missing a step's output while the step row is 'completed'.

  if (result.waitSpec) {
    const spec = result.waitSpec;
    const nextRunAt = spec.kind === "until" ? new Date(spec.until) : undefined;
    await atomicStepCompletion(executionId, stepId, result.output, {
      kind: "wait",
      nextRunAt,
    });
    console.log(
      `[engine] Execution ${executionId} step ${stepId} waiting (${spec.kind})`,
    );

    // ── Enqueue the appropriate delayed BullMQ job ────────────────────────
    if (spec.kind === "until") {
      // Schedule a delayed workflow.resume that fires when the `until` time
      // arrives.  The resume handler calls `wait_until` again with a resume
      // payload, which returns immediately (no waitSpec) and lets the engine
      // advance linearly.
      const delayMs = Math.max(0, new Date(spec.until).getTime() - Date.now());
      const resumeJobId = `workflow|resume|timeout|${executionId}|${stepId}`;
      await enqueueJob(
        "workflow",
        {
          jobType: JobType.WORKFLOW_RESUME,
          requestId: randomUUID(),
          idempotencyKey: resumeJobId,
          userId,
          payload: {
            executionId,
            stepId,
            resumeKey: "timer",
            resumePayload: { resumeReason: "timer" },
          } as Record<string, unknown>,
        },
        { jobId: resumeJobId, delayMs, retries: 5 },
      );
      console.log(
        `[engine] Scheduled resume in ${delayMs}ms for execution=${executionId} step=${stepId} (job=${resumeJobId})`,
      );
    } else if (spec.kind === "input") {
      // Schedule workflow.timeout to fire after timeoutSeconds if the user
      // never submits an action.  The timeout processor checks that the
      // execution is still waiting on this step before acting, so a stale
      // timeout that arrives after a successful user action is a no-op.
      const delayMs = spec.timeoutSeconds * 1_000;
      const timeoutJobId = `workflow|timeout|${executionId}|${stepId}`;
      await enqueueJob(
        "workflow",
        {
          jobType: JobType.WORKFLOW_TIMEOUT,
          requestId: randomUUID(),
          idempotencyKey: timeoutJobId,
          userId,
          payload: { executionId, stepId } as Record<string, unknown>,
        },
        { jobId: timeoutJobId, delayMs, retries: 5 },
      );
      console.log(
        `[engine] Scheduled timeout in ${delayMs}ms for execution=${executionId} step=${stepId} (job=${timeoutJobId})`,
      );
    }

    return;
  }

  // ── 11. Determine next step ────────────────────────────────────────────────
  let resolvedNextStepId: string | null;
  if (result.nextStepId !== undefined) {
    resolvedNextStepId = result.nextStepId;
  } else {
    resolvedNextStepId = nextStepAfter(steps, stepId);
  }

  // Validate the target step exists before we commit anything.
  if (
    resolvedNextStepId !== null &&
    !steps.find((s) => s.id === resolvedNextStepId)
  ) {
    const msg = `Next step "${resolvedNextStepId}" not found in workflow definition`;
    await markExecutionFailed(executionId, msg);
    throw new ExecutionStateError(executionId, msg);
  }

  // ── 12. Commit output + advance or complete (single transaction) ──────────
  if (resolvedNextStepId === null) {
    // No more steps — atomically complete the step and the execution.
    await atomicStepCompletion(executionId, stepId, result.output, {
      kind: "complete",
    });

    await recordAuditLog({
      userId,
      actorType: "worker",
      action: "workflow.execution.completed",
      entityType: "workflow_execution",
      entityId: executionId,
      idempotencyKey: buildEffectKey(
        "workflow.execution.completed",
        executionId,
      ),
      requestId,
      payload: { executionId, lastStepId: stepId },
    });

    console.log(
      `[engine] Execution ${executionId} completed after step ${stepId}`,
    );
    return;
  }

  // Atomically complete the step, append its output, and advance current_step.
  await atomicStepCompletion(executionId, stepId, result.output, {
    kind: "next",
    nextStepId: resolvedNextStepId,
  });

  // Enqueue the next workflow.run job with a deterministic jobId.
  const nextJobId = `workflow|run|${executionId}|${resolvedNextStepId}|0`;
  await enqueueJob(
    "workflow",
    {
      jobType: JobType.WORKFLOW_RUN,
      requestId: randomUUID(),
      idempotencyKey: nextJobId,
      userId,
      payload: {
        executionId,
        stepId: resolvedNextStepId,
        attempt: 0,
      } as Record<string, unknown>,
    },
    { jobId: nextJobId, retries: 12 },
  );

  console.log(
    `[engine] Execution ${executionId} advanced: ${stepId} → ${resolvedNextStepId}`,
  );
}
