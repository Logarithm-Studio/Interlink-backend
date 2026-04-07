/**
 * Workflow state transitions — all DB writes that advance the execution or step
 * state machine.
 *
 * Optimistic concurrency strategy
 * ─────────────────────────────────
 * Execution status uses compare-and-swap: every mutating UPDATE includes a
 * WHERE clause on the current expected status.  If 0 rows are affected the
 * transition was already performed by another worker — this is treated as an
 * idempotent success (we log a warning and continue).
 *
 * Step rows use UPSERT so that BullMQ retries can re-enter cleanly without
 * leaving orphaned rows.
 */

import { query, getPool } from "../config/db";

// ─── Execution transitions ─────────────────────────────────────────────────

/**
 * Transition an execution from `pending` → `running`.
 * Called once, on the first step of a new execution.
 * Returns `true` if the transition succeeded; `false` if the execution was
 * already in a non-pending state (concurrent runner or already completed).
 */
export async function claimExecutionPending(
  executionId: string,
  firstStepId: string,
): Promise<boolean> {
  const result = await query(
    `UPDATE workflow_executions
     SET status = 'running', current_step = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'pending'`,
    [executionId, firstStepId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Transition an execution from `waiting` → `running`.
 * Called when a `workflow.resume` job is processed.
 * Returns `true` if the transition succeeded.
 */
export async function claimExecutionWaiting(
  executionId: string,
  stepId: string,
): Promise<boolean> {
  const result = await query(
    `UPDATE workflow_executions
     SET status = 'running', current_step = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'waiting'`,
    [executionId, stepId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Update `current_step` while the execution stays `running`.
 * Called between steps to track which step is active.
 */
export async function advanceExecutionStep(
  executionId: string,
  nextStepId: string,
): Promise<void> {
  await query(
    `UPDATE workflow_executions
     SET current_step = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'running'`,
    [executionId, nextStepId],
  );
}

/**
 * Mark an execution as `completed` (all steps finished successfully).
 */
export async function markExecutionCompleted(
  executionId: string,
): Promise<void> {
  await query(
    `UPDATE workflow_executions
     SET status = 'completed', current_step = NULL, updated_at = NOW()
     WHERE id = $1 AND status = 'running'`,
    [executionId],
  );
}

/**
 * Mark an execution as `failed`.
 * `reason` is stored in the context under a reserved `_failure` key.
 */
export async function markExecutionFailed(
  executionId: string,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE workflow_executions
     SET status    = 'failed',
         updated_at = NOW(),
         context   = jsonb_set(context, '{_failure}', $2::jsonb, true)
     WHERE id = $1 AND status IN ('running', 'pending')`,
    [
      executionId,
      JSON.stringify({ reason, failedAt: new Date().toISOString() }),
    ],
  );
}

/**
 * Mark an execution as `waiting` (a step returned a wait spec).
 * `nextRunAt` is the earliest time the execution should resume (for wait_until).
 */
export async function markExecutionWaiting(
  executionId: string,
  stepId: string,
  nextRunAt?: Date,
): Promise<void> {
  if (nextRunAt) {
    await query(
      `UPDATE workflow_executions
       SET status = 'waiting', current_step = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'running'`,
      [executionId, stepId],
    );
    // next_run_at is stored on the step row (see markStepWaiting)
  } else {
    await query(
      `UPDATE workflow_executions
       SET status = 'waiting', current_step = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'running'`,
      [executionId, stepId],
    );
  }
}

// ─── Append-only context updates ─────────────────────────────────────────────

/**
 * Append a step's output into `execution.context.outputs[stepId]`.
 * Uses PostgreSQL's `jsonb_set` with create-if-missing semantics.
 * This is the only way context is written — never full-replace.
 */
export async function appendStepOutputToContext(
  executionId: string,
  stepId: string,
  output: Record<string, unknown>,
): Promise<void> {
  // Build a safe key path: replace dots with underscores to keep it as a single
  // JSON key (step IDs should not contain dots but this is defensive).
  const safeKey = stepId.replace(/\./g, "_");
  await query(
    `UPDATE workflow_executions
     SET context    = jsonb_set(
                        jsonb_set(context, '{outputs}',
                          COALESCE(context->'outputs', '{}'::jsonb),
                          true),
                        ARRAY['outputs', $2::text],
                        $3::jsonb,
                        true),
         updated_at = NOW()
     WHERE id = $1`,
    [executionId, safeKey, JSON.stringify(output)],
  );
}

// ─── Step transitions ──────────────────────────────────────────────────────

/**
 * Upsert the step row to `running`.
 * Safe to call on retries — just bumps `attempt` and clears previous error.
 */
export async function markStepRunning(
  executionId: string,
  stepId: string,
  attempt: number,
  input: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO workflow_execution_steps
       (execution_id, step_id, status, attempt, input, started_at)
     VALUES ($1, $2, 'running', $3, $4, NOW())
     ON CONFLICT (execution_id, step_id)
     DO UPDATE SET
       status     = 'running',
       attempt    = EXCLUDED.attempt,
       input      = EXCLUDED.input,
       started_at = NOW(),
       error      = NULL`,
    [executionId, stepId, attempt, JSON.stringify(input)],
  );
}

/**
 * Mark the step as `completed` and record its output + finish time.
 */
export async function markStepCompleted(
  executionId: string,
  stepId: string,
  output: Record<string, unknown>,
): Promise<void> {
  await query(
    `UPDATE workflow_execution_steps
     SET status      = 'completed',
         output      = $3::jsonb,
         finished_at = NOW()
     WHERE execution_id = $1 AND step_id = $2 AND status = 'running'`,
    [executionId, stepId, JSON.stringify(output)],
  );
}

/**
 * Mark the step as `failed` and record the error.
 * BullMQ will retry the job; on the next attempt `markStepRunning` will reset it.
 */
export async function markStepFailed(
  executionId: string,
  stepId: string,
  error: unknown,
): Promise<void> {
  const errorPayload =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error) };

  await query(
    `UPDATE workflow_execution_steps
     SET status      = 'failed',
         error       = $3::jsonb,
         finished_at = NOW()
     WHERE execution_id = $1 AND step_id = $2`,
    [executionId, stepId, JSON.stringify(errorPayload)],
  );
}

/**
 * Mark the step as `waiting` (e.g. wait_until / wait_for_input).
 * `nextRunAt` stores when the timer should fire (for wait_until).
 */
export async function markStepWaiting(
  executionId: string,
  stepId: string,
  nextRunAt?: Date,
): Promise<void> {
  await query(
    `UPDATE workflow_execution_steps
     SET status     = 'waiting',
         next_run_at = $3
     WHERE execution_id = $1 AND step_id = $2`,
    [executionId, stepId, nextRunAt ?? null],
  );
}

// ─── Atomic step completion transaction ───────────────────────────────────────

/**
 * Describes how an execution should advance after a step completes.
 */
export type StepAdvance =
  | { kind: "next"; nextStepId: string }
  | { kind: "complete" }
  | { kind: "wait"; nextRunAt?: Date };

/**
 * Atomically persist a completed step's output and advance the execution state
 * in a single Postgres transaction.
 *
 * Three outcomes are handled:
 * - "next"     — step finished; advance `current_step` to `nextStepId`.
 * - "complete" — last step finished; mark execution `completed`.
 * - "wait"     — step is pausing (wait_until / wait_for_input); mark both
 *                the step row and the execution as `waiting`.
 *
 * If any write fails the entire transaction rolls back, leaving the step row
 * in `running` state so BullMQ will retry and the engine re-enters cleanly
 * without losing any output.
 */
export async function atomicStepCompletion(
  executionId: string,
  stepId: string,
  output: Record<string, unknown>,
  advance: StepAdvance,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  // JSON key must not contain dots — replace them to stay as a single JSON key.
  const safeKey = stepId.replace(/\./g, "_");
  const outputJson = JSON.stringify(output);

  try {
    await client.query("BEGIN");

    // 1. Mark step as completed and persist its output.
    await client.query(
      `UPDATE workflow_execution_steps
       SET status      = 'completed',
           output      = $3::jsonb,
           finished_at = NOW()
       WHERE execution_id = $1 AND step_id = $2 AND status = 'running'`,
      [executionId, stepId, outputJson],
    );

    // 2. Append output to execution context (append-only, never full-replace).
    await client.query(
      `UPDATE workflow_executions
       SET context    = jsonb_set(
                          jsonb_set(context, '{outputs}',
                            COALESCE(context->'outputs', '{}'::jsonb), true),
                          ARRAY['outputs', $2::text], $3::jsonb, true),
           updated_at = NOW()
       WHERE id = $1`,
      [executionId, safeKey, outputJson],
    );

    // 3. Advance execution state.
    if (advance.kind === "next") {
      await client.query(
        `UPDATE workflow_executions
         SET current_step = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [executionId, advance.nextStepId],
      );
    } else if (advance.kind === "complete") {
      await client.query(
        `UPDATE workflow_executions
         SET status       = 'completed',
             current_step = NULL,
             updated_at   = NOW()
         WHERE id = $1 AND status = 'running'`,
        [executionId],
      );
    } else {
      // kind === "wait": mark step waiting and execution waiting atomically.
      await client.query(
        `UPDATE workflow_execution_steps
         SET status      = 'waiting',
             next_run_at = $3
         WHERE execution_id = $1 AND step_id = $2`,
        [executionId, stepId, advance.nextRunAt ?? null],
      );
      await client.query(
        `UPDATE workflow_executions
         SET status       = 'waiting',
             current_step = $2,
             updated_at   = NOW()
         WHERE id = $1 AND status = 'running'`,
        [executionId, stepId],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
