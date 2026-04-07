/**
 * `wait_for_input` step handler — pause execution and wait for an explicit
 * user action submitted via `POST /api/v1/workflows/actions`.
 *
 * Execution flow:
 * 1. First invocation — no `resumePayload`.  The handler returns a `waitSpec`
 *    so the engine puts the execution into the `waiting` state and schedules
 *    a delayed `workflow.timeout` job.
 *
 * 2a. User action — the workflow actions API enqueues a `workflow.resume` job
 *     with `resumePayload.actionKey`.  This handler looks up
 *     `config.routes[actionKey]` and returns the corresponding `nextStepId`.
 *     If the `actionKey` is not in `routes`, we fall back to
 *     `config.timeoutNextStepId` (if present) or `null` (end of execution).
 *
 * 2b. Timeout — the `workflow.timeout` processor fires and enqueues a
 *     `workflow.resume` with `resumePayload.resumeReason === "timeout"`.
 *     The handler routes to `config.timeoutNextStepId ?? null`.
 *
 * Idempotency: BullMQ job IDs for the timeout job follow the pattern
 * `workflow:timeout:<executionId>:<stepId>` — enqueueing the same job twice
 * is a no-op.  The timeout processor guards on execution.currentStep before
 * taking any action, so a stale timeout that arrives after user input is
 * silently discarded.
 */

import type { StepContext, StepResult } from "../registry";

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * Wait-for-input step handler — exported for direct registration.
 */
export async function waitForInputHandler(
  ctx: StepContext,
): Promise<StepResult> {
  const config = ctx.stepDefinition.config as {
    timeoutSeconds: number;
    timeoutNextStepId?: string | null;
    routes: Record<string, string>;
  };

  const routes: Record<string, string> = config.routes ?? {};

  // Resume path — a user action or timeout has fired.
  if (ctx.resumePayload) {
    const actionKey = ctx.resumePayload.actionKey as string | undefined;
    const resumeReason = ctx.resumePayload.resumeReason as string | undefined;

    if (resumeReason === "timeout") {
      // Timeout branch.
      const nextStepId: string | null = config.timeoutNextStepId ?? null;
      console.log(
        `[wait_for_input] Timed out → nextStep=${nextStepId ?? "null (end)"} | execution=${ctx.executionId} step=${ctx.stepId}`,
      );
      return {
        output: { timedOut: true },
        nextStepId,
      };
    }

    if (actionKey) {
      // User submitted an explicit action.
      const nextStepId: string | null =
        routes[actionKey] ?? config.timeoutNextStepId ?? null;
      console.log(
        `[wait_for_input] Resumed via action="${actionKey}" → nextStep=${nextStepId ?? "null (end)"} | execution=${ctx.executionId} step=${ctx.stepId}`,
      );
      return {
        output: { actionKey, resolved: true },
        nextStepId,
      };
    }

    // Unknown resume payload — continue linearly.
    console.warn(
      `[wait_for_input] Unknown resumePayload — continuing linearly | execution=${ctx.executionId} step=${ctx.stepId}`,
      ctx.resumePayload,
    );
    return {
      output: { resumed: true, unknownPayload: true },
    };
  }

  // First invocation — put the execution into the waiting state.
  console.log(
    `[wait_for_input] Waiting for input (timeout=${config.timeoutSeconds}s) | execution=${ctx.executionId} step=${ctx.stepId}`,
  );

  return {
    output: {
      waiting: true,
      timeoutSeconds: config.timeoutSeconds,
    },
    waitSpec: {
      kind: "input",
      timeoutSeconds: config.timeoutSeconds,
      ...(config.timeoutNextStepId != null
        ? { timeoutNextStepId: config.timeoutNextStepId }
        : {}),
      routes,
    },
  };
}
