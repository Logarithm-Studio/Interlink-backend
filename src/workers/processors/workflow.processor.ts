import { randomUUID } from "crypto";
import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { enqueueJob } from "../../services/jobQueue.service";
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

// Ensure built-in step handlers are registered.
import "../../workflow/registry";

export async function processWorkflowJob(
  rawData: unknown,
  jobId: string,
): Promise<void> {
  const envelope = JobEnvelopeSchema.parse(rawData);

  switch (envelope.jobType) {
    case JobType.WORKFLOW_RUN: {
      const { executionId, stepId, attempt = 0 } = envelope.payload as {
        executionId: string;
        stepId: string;
        attempt?: number;
      };

      console.log(
        `[workflow] workflow.run | execution=${executionId} step=${stepId} attempt=${attempt} | job=${jobId}`,
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
          console.log(`[workflow] workflow.run clean exit: ${err.message}`);
          return;
        }
        if (err instanceof UnregisteredStepTypeError) {
          console.error(
            `[workflow] Permanent failure — no handler for step type: ${err.stepType}`,
          );
          await markExecutionFailed(executionId, err.message).catch(console.error);
          await recordAuditLog({
            userId: envelope.userId,
            actorType: "worker",
            action: "workflow.execution.failed",
            entityType: "workflow_execution",
            entityId: executionId,
            idempotencyKey: buildEffectKey("workflow.execution.failed", executionId),
            requestId: envelope.requestId,
            payload: { reason: err.message, stepId },
          }).catch(console.error);
          return;
        }
        throw err;
      }
      break;
    }

    case JobType.WORKFLOW_RESUME: {
      const { executionId, stepId, resumeKey, resumePayload } =
        envelope.payload as {
          executionId: string;
          stepId: string;
          resumeKey?: string;
          resumePayload?: Record<string, unknown>;
        };

      console.log(
        `[workflow] workflow.resume | execution=${executionId} step=${stepId} key=${resumeKey ?? "n/a"} | job=${jobId}`,
      );

      const execution = await getExecution(executionId);
      if (!execution) {
        console.warn(`[workflow] workflow.resume: execution ${executionId} not found — skipping`);
        return;
      }
      if (execution.status === "completed" || execution.status === "failed") {
        console.log(`[workflow] workflow.resume: execution ${executionId} already ${execution.status} — skipping`);
        return;
      }

      const step = await getStep(executionId, stepId);
      if (!step || step.status === "completed") {
        console.log(`[workflow] workflow.resume: step ${stepId} already completed — skipping`);
        return;
      }

      if (execution.status === "waiting") {
        const claimed = await claimExecutionWaiting(executionId, stepId);
        if (!claimed) {
          console.warn(`[workflow] workflow.resume: could not claim execution ${executionId} — skipping`);
          return;
        }
      }

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
          resumePayload: Object.keys(mergedResumePayload).length > 0 ? mergedResumePayload : undefined,
        });
      } catch (err) {
        if (err instanceof ExecutionStateError) {
          console.log(`[workflow] workflow.resume clean exit: ${err.message}`);
          return;
        }
        throw err;
      }
      break;
    }

    case JobType.WORKFLOW_TIMEOUT: {
      const { executionId, stepId } = envelope.payload as {
        executionId: string;
        stepId: string;
      };

      console.log(
        `[workflow] workflow.timeout | execution=${executionId} step=${stepId} | job=${jobId}`,
      );

      const timedExecution = await getExecution(executionId);
      if (!timedExecution) {
        console.warn(`[workflow] workflow.timeout: execution ${executionId} not found — skipping`);
        return;
      }
      if (timedExecution.status !== "waiting" || timedExecution.currentStep !== stepId) {
        console.log(`[workflow] workflow.timeout: stale — discarding`);
        return;
      }

      const timedClaimed = await claimExecutionWaiting(executionId, stepId);
      if (!timedClaimed) {
        console.warn(`[workflow] workflow.timeout: could not claim execution ${executionId} — skipping`);
        return;
      }

      const timedWorkflow = await getWorkflow(timedExecution.workflowId);
      if (!timedWorkflow) {
        await markExecutionFailed(executionId, `workflow.timeout: workflow ${timedExecution.workflowId} not found`);
        return;
      }

      const timedStepDef = timedWorkflow.definition.steps.find((s) => s.id === stepId);
      const timeoutNextStepId =
        timedStepDef != null &&
        typeof (timedStepDef.config as Record<string, unknown>).timeoutNextStepId === "string"
          ? ((timedStepDef.config as Record<string, unknown>).timeoutNextStepId as string)
          : null;

      if (timeoutNextStepId) {
        await advanceExecutionStep(executionId, timeoutNextStepId);

        const timeoutRunJobId = `workflow|run|${executionId}|${timeoutNextStepId}|0`;
        await enqueueJob(
          "workflow",
          {
            jobType: JobType.WORKFLOW_RUN,
            requestId: randomUUID(),
            idempotencyKey: timeoutRunJobId,
            userId: envelope.userId,
            payload: { executionId, stepId: timeoutNextStepId, attempt: 0 } as Record<string, unknown>,
          },
          { jobId: timeoutRunJobId, retries: 12 },
        );

        console.log(
          `[workflow] workflow.timeout: execution ${executionId} timed out → advancing to ${timeoutNextStepId}`,
        );
      } else {
        const reason = `Timed out waiting for input on step "${stepId}" (no timeoutNextStepId)`;
        await markExecutionFailed(executionId, reason);
        await recordAuditLog({
          userId: envelope.userId,
          actorType: "worker",
          action: "workflow.execution.failed",
          entityType: "workflow_execution",
          entityId: executionId,
          idempotencyKey: buildEffectKey("workflow.execution.failed.timeout", executionId, stepId),
          requestId: envelope.requestId,
          payload: { reason, stepId },
        }).catch(console.error);

        console.log(`[workflow] workflow.timeout: execution ${executionId} failed — no timeoutNextStepId`);
      }
      break;
    }

    default:
      console.warn(`[workflow] unknown jobType=${envelope.jobType} | job=${jobId}`);
  }
}

// Called by the worker route when QStash exhausts all retries (via failureCallback URL).
export async function handleWorkflowJobExhausted(
  rawData: unknown,
  errorMessage: string,
): Promise<void> {
  const envelope = JobEnvelopeSchema.safeParse(rawData);
  if (!envelope.success) return;

  const { executionId } = envelope.data.payload as { executionId?: string };
  if (!executionId) return;

  await markExecutionFailed(executionId, errorMessage).catch(console.error);
  await recordAuditLog({
    userId: envelope.data.userId,
    actorType: "worker",
    action: "workflow.execution.failed",
    entityType: "workflow_execution",
    entityId: executionId,
    idempotencyKey: buildEffectKey("workflow.execution.failed.exhausted", executionId),
    requestId: envelope.data.requestId,
    payload: { error: errorMessage, executionId },
  }).catch(console.error);

  // Send to DLQ for audit trail.
  await enqueueJob(
    "dlq",
    {
      jobType: "dlq.workflow",
      requestId: randomUUID(),
      idempotencyKey: `dlq:exhausted:${executionId}`,
      userId: envelope.data.userId,
      payload: { originalData: rawData, error: errorMessage },
    },
    { retries: 1 },
  ).catch(console.error);
}
