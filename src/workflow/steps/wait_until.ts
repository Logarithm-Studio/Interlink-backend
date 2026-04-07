/**
 * `wait_until` step handler — pause execution until a fixed point in time.
 *
 * Config field `until` accepts either:
 * - An ISO-8601 datetime string — used directly as the resume timestamp.
 * - A dot-path into the execution context (e.g. `"outputs.step1.scheduledAt"`) —
 *   the resolved value must be a valid ISO-8601 string.
 *
 * Execution flow:
 * 1. First invocation — resolves `until`, validates it, returns a `waitSpec`
 *    so the engine transitions the execution to `waiting` and schedules a
 *    delayed `workflow.resume` job.
 * 2. Timer fires — the delayed `workflow.resume` job calls this handler again
 *    with `resumePayload.resumeReason === "timer"`.  The handler returns
 *    immediately (no `waitSpec`) so the engine advances to the next step.
 *
 * Idempotency: if the `until` timestamp is in the past the delay is clamped to
 * 0 ms — BullMQ will still enqueue the resume job and process it on the next
 * available run.
 */

import type { StepContext, StepResult } from "../registry";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the `until` config value.
 *
 * ISO-8601 strings start with a four-digit year; anything else is treated as
 * a dot-path into executionContext.
 */
function resolveUntil(raw: string, ctx: Record<string, unknown>): string {
  if (/^\d{4}-/.test(raw)) {
    // Looks like a literal ISO-8601 date — use as-is.
    return raw;
  }

  // Treat as a dot-path into the execution context.
  const parts = raw.split(".");
  let val: unknown = ctx;
  for (const part of parts) {
    if (val == null || typeof val !== "object") {
      val = undefined;
      break;
    }
    val = (val as Record<string, unknown>)[part];
  }

  if (typeof val !== "string") {
    throw new Error(
      `wait_until: could not resolve dot-path "${raw}" to a string — got ${typeof val}`,
    );
  }
  return val;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * Wait-until step handler — exported for direct registration in the registry.
 */
export async function waitUntilHandler(ctx: StepContext): Promise<StepResult> {
  const config = ctx.stepDefinition.config as {
    until: string;
    timeoutNextStepId?: string;
  };

  // Resume path: the delayed timer job already fired.
  if (ctx.resumePayload) {
    const reason = ctx.resumePayload.resumeReason as string | undefined;
    console.log(
      `[wait_until] Resumed | execution=${ctx.executionId} step=${ctx.stepId} reason=${reason ?? "unknown"}`,
    );
    return {
      output: { resumed: true, resumeReason: reason ?? "timer" },
      // nextStepId undefined → linear progression (default).
    };
  }

  // First run — validate `until` and return the wait spec.
  const until = resolveUntil(config.until, ctx.executionContext);
  const untilMs = Date.parse(until);
  if (isNaN(untilMs)) {
    throw new Error(
      `wait_until: invalid datetime string "${until}" (step ${ctx.stepId})`,
    );
  }

  const delayMs = Math.max(0, untilMs - Date.now());
  console.log(
    `[wait_until] Waiting ${delayMs}ms | execution=${ctx.executionId} step=${ctx.stepId} until=${until}`,
  );

  return {
    output: {
      waitingUntil: until,
      delayMs,
    },
    waitSpec: {
      kind: "until",
      until,
      ...(config.timeoutNextStepId != null
        ? { timeoutNextStepId: config.timeoutNextStepId }
        : {}),
    },
  };
}
