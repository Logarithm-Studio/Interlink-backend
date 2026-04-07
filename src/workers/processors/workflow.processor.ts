import { randomUUID } from "crypto";
import { Worker, Job } from "bullmq";
import { getConnection } from "../../queues/connection";
import { getWorkflowQueue, getDlqQueue } from "../../queues/queues";
import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import {
  runStep,
  ExecutionStateError,
  UnregisteredStepTypeError,
} from "../../workflow/engine";
import {
  claimExecutionWaiting,
  markExecutionFailed,
  advanceExecutionStep,
} from "../../workflow/state";
import {
  getExecution,
  getStep,
  getWorkflow,
} from "../../services/workflows.service";
import { recordAuditLog, buildEffectKey } from "../../security/idempotency";

// ─── Ensure all built-in step handlers are registered ────────────────────────
// Importing registry.ts triggers the top-level registerStep() calls for
// built-in and stub handlers.
import "../../workflow/registry";

export function startWorkflowWorker(): Worker {
  const worker = new Worker(
    "workflow",
    async (job: Job) => {
      const envelope = JobEnvelopeSchema.parse(job.data);

      switch (envelope.jobType) {
        // ── workflow.run ──────────────────────────────────────────────────────
        // Run a single step and advance the execution state machine.
        case JobType.WORKFLOW_RUN: {
          const {
            executionId,
            stepId,
            attempt = 0,
          } = envelope.payload as {
            executionId: string;
            stepId: string;
            attempt?: number;
          };

          console.log(
            `[workflow] workflow.run | execution=${executionId} step=${stepId} attempt=${attempt} | job=${job.id}`,
          );

          try {
            await runStep({
              executionId,
              stepId,
              attempt,
              userId: envelope.userId,
              jobIdempotencyKey: envelope.idempotencyKey,
              requestId: envelope.requestId,
            });
          } catch (err) {
            if (err instanceof ExecutionStateError) {
              // Clean exit — execution was already in a terminal state.
              console.log(`[workflow] workflow.run clean exit: ${err.message}`);
              return;
            }
            if (err instanceof UnregisteredStepTypeError) {
              // Permanent failure — no handler registered; mark execution failed.
              console.error(
                `[workflow] Permanent failure — no handler for step type: ${err.stepType}`,
              );
              await markExecutionFailed(executionId, err.message).catch(
                console.error,
              );
              await recordAuditLog({
                userId: envelope.userId,
                actorType: "worker",
                action: "workflow.execution.failed",
                entityType: "workflow_execution",
                entityId: executionId,
                idempotencyKey: buildEffectKey(
                  "workflow.execution.failed",
                  executionId,
                ),
                requestId: envelope.requestId,
                payload: { reason: err.message, stepId },
              }).catch(console.error);
              return; // Do not re-throw — no point retrying with no handler.
            }
            // Transient error — let BullMQ retry.
            throw err;
          }
          break;
        }

        // ── workflow.resume ───────────────────────────────────────────────────
        // Resume an execution from a waiting step after a user action or timer.
        case JobType.WORKFLOW_RESUME: {
          const { executionId, stepId, resumeKey, resumePayload } =
            envelope.payload as {
              executionId: string;
              stepId: string;
              resumeKey?: string;
              resumePayload?: Record<string, unknown>;
            };

          console.log(
            `[workflow] workflow.resume | execution=${executionId} step=${stepId} key=${resumeKey ?? "n/a"} | job=${job.id}`,
          );

          // Guard: execution must be waiting.
          const execution = await getExecution(executionId);
          if (!execution) {
            console.warn(
              `[workflow] workflow.resume: execution ${executionId} not found — skipping`,
            );
            return;
          }
          if (
            execution.status === "completed" ||
            execution.status === "failed"
          ) {
            console.log(
              `[workflow] workflow.resume: execution ${executionId} already ${execution.status} — skipping`,
            );
            return;
          }

          // Guard: step must be waiting.
          const step = await getStep(executionId, stepId);
          if (!step || step.status === "completed") {
            console.log(
              `[workflow] workflow.resume: step ${stepId} already completed — skipping`,
            );
            return;
          }

          // Transition execution waiting → running.
          if (execution.status === "waiting") {
            const claimed = await claimExecutionWaiting(executionId, stepId);
            if (!claimed) {
              console.warn(
                `[workflow] workflow.resume: could not claim execution ${executionId} (status=${execution.status}) — another worker may have resumed it`,
              );
              return;
            }
          }

          // Re-run the waiting step with the resume payload.
          // Always include resumeKey in the payload so step handlers can
          // identify which action the user took, even when the API sends an
          // empty resumePayload object.
          const mergedResumePayload: Record<string, unknown> = {
            ...(resumePayload ?? {}),
            ...(resumeKey ? { resumeKey, actionKey: resumeKey } : {}),
          };

          try {
            await runStep({
              executionId,
              stepId,
              attempt: step.attempt,
              userId: envelope.userId,
              jobIdempotencyKey: envelope.idempotencyKey,
              requestId: envelope.requestId,
              resumePayload:
                Object.keys(mergedResumePayload).length > 0
                  ? mergedResumePayload
                  : undefined,
            });
          } catch (err) {
            if (err instanceof ExecutionStateError) {
              console.log(
                `[workflow] workflow.resume clean exit: ${err.message}`,
              );
              return;
            }
            throw err;
          }
          break;
        }

        // ── workflow.timeout ──────────────────────────────────────────────────
        // Enforce definition-controlled timeouts on wait states.
        // If the execution is still waiting on the same step, either advance to
        // the timeoutNextStepId or mark the execution failed.
        case JobType.WORKFLOW_TIMEOUT: {
          const { executionId, stepId } = envelope.payload as {
            executionId: string;
            stepId: string;
          };

          console.log(
            `[workflow] workflow.timeout | execution=${executionId} step=${stepId} | job=${job.id}`,
          );

          // Guard: load execution and validate it is still waiting on this step.
          const timedExecution = await getExecution(executionId);
          if (!timedExecution) {
            console.warn(
              `[workflow] workflow.timeout: execution ${executionId} not found — skipping`,
            );
            return;
          }
          if (
            timedExecution.status !== "waiting" ||
            timedExecution.currentStep !== stepId
          ) {
            // User already acted (or execution moved on) — stale timeout; discard.
            console.log(
              `[workflow] workflow.timeout: execution ${executionId} no longer waiting on step ${stepId} (status=${timedExecution.status}, currentStep=${timedExecution.currentStep ?? "null"}) — discarding stale timeout`,
            );
            return;
          }

          // Claim the execution: waiting → running.
          const timedClaimed = await claimExecutionWaiting(executionId, stepId);
          if (!timedClaimed) {
            console.warn(
              `[workflow] workflow.timeout: could not claim execution ${executionId} — another process may have acted concurrently`,
            );
            return;
          }

          // Load the workflow definition to find timeoutNextStepId.
          const timedWorkflow = await getWorkflow(timedExecution.workflowId);
          if (!timedWorkflow) {
            await markExecutionFailed(
              executionId,
              `workflow.timeout: workflow ${timedExecution.workflowId} not found`,
            );
            return;
          }

          const timedStepDef = timedWorkflow.definition.steps.find(
            (s) => s.id === stepId,
          );
          const timeoutNextStepId =
            timedStepDef != null &&
            typeof (timedStepDef.config as Record<string, unknown>)
              .timeoutNextStepId === "string"
              ? ((timedStepDef.config as Record<string, unknown>)
                  .timeoutNextStepId as string)
              : null;

          if (timeoutNextStepId) {
            // Advance to the timeout branch step and enqueue a workflow.run job.
            await advanceExecutionStep(executionId, timeoutNextStepId);

            const timeoutRunJobId = `workflow|run|${executionId}|${timeoutNextStepId}|0`;
            await getWorkflowQueue().add(
              JobType.WORKFLOW_RUN,
              {
                jobType: JobType.WORKFLOW_RUN,
                requestId: randomUUID(),
                idempotencyKey: timeoutRunJobId,
                userId: envelope.userId,
                payload: {
                  executionId,
                  stepId: timeoutNextStepId,
                  attempt: 0,
                } as Record<string, unknown>,
              },
              {
                jobId: timeoutRunJobId,
                // workflow.* policy: 12 attempts, exponential 5s base, 15m cap.
                attempts: 12,
                backoff: {
                  type: "workflow_exp" as "exponential",
                  delay: 5_000,
                },
              },
            );

            console.log(
              `[workflow] workflow.timeout: execution ${executionId} timed out on step ${stepId} → advancing to ${timeoutNextStepId}`,
            );
          } else {
            // No timeout route defined — mark execution as failed.
            const reason = `Timed out waiting for input on step "${stepId}" (no timeoutNextStepId)`;
            await markExecutionFailed(executionId, reason);
            await recordAuditLog({
              userId: envelope.userId,
              actorType: "worker",
              action: "workflow.execution.failed",
              entityType: "workflow_execution",
              entityId: executionId,
              idempotencyKey: buildEffectKey(
                "workflow.execution.failed.timeout",
                executionId,
                stepId,
              ),
              requestId: envelope.requestId,
              payload: { reason, stepId },
            }).catch(console.error);

            console.log(
              `[workflow] workflow.timeout: execution ${executionId} failed — no timeoutNextStepId on step ${stepId}`,
            );
          }
          break;
        }

        default:
          console.warn(`[workflow] unknown jobType=${envelope.jobType}`);
      }
    },
    {
      connection: getConnection(),
      concurrency: 5,
      settings: {
        // Cap exponential delay at 15 minutes (900 000 ms).
        backoffStrategy: (
          attemptsMade: number,
          type?: string,
          _err?: Error,
        ) => {
          if (type === "workflow_exp") {
            return Math.min(5_000 * Math.pow(2, attemptsMade - 1), 900_000);
          }
          return Math.pow(2, attemptsMade) * 5_000; // fallback
        },
      },
    },
  );

  // After all retries exhausted — mark execution failed and send to DLQ.
  worker.on("failed", async (job, err) => {
    console.error(`[workflow] job ${job?.id} permanently failed:`, err.message);

    if (!job) return;
    try {
      const envelope = JobEnvelopeSchema.safeParse(job.data);
      if (!envelope.success) return;

      const { executionId } = envelope.data.payload as { executionId?: string };
      if (executionId) {
        await markExecutionFailed(executionId, err.message);
        await recordAuditLog({
          userId: envelope.data.userId,
          actorType: "worker",
          action: "workflow.execution.failed",
          entityType: "workflow_execution",
          entityId: executionId,
          idempotencyKey: buildEffectKey(
            "workflow.execution.failed.exhausted",
            job.id ?? executionId,
          ),
          requestId: envelope.data.requestId,
          payload: { jobId: job.id, error: err.message, executionId },
        });
      }

      await getDlqQueue().add(
        "dlq.workflow",
        {
          jobType: "dlq.workflow",
          requestId: randomUUID(),
          idempotencyKey: `dlq:${job.id}`,
          userId: envelope.data.userId,
          payload: {
            originalJobId: job.id,
            originalData: job.data,
            error: err.message,
          },
        },
        { attempts: 1 },
      );
    } catch (dlqErr) {
      console.error("[workflow] DLQ enqueue failed:", dlqErr);
    }
  });

  return worker;
}
