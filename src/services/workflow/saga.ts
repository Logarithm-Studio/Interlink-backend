/**
 * Saga runner — transaction boundaries + rollback for multi-app workflows.
 *
 * Requirement: "Every multi-app workflow action must maintain transaction boundaries.
 * If a downstream action fails (e.g. DocuSign fails after HubSpot creates a record),
 * Interlink must roll back previous changes to maintain data integrity."
 *
 * Third-party APIs have no distributed transactions, so we use the standard
 * compensating-transaction (saga) pattern: each step declares how to UNDO itself. If a
 * later step throws, we run the completed steps' `undo` handlers in reverse (LIFO) to
 * return the world to its pre-workflow state.
 *
 * Rules:
 *  - A step with no `undo` is a read or an inherently irreversible send (e.g. an email
 *    that has left the building). Order workflows so irreversible steps come LAST.
 *  - Compensation failures never mask the original error: they are collected and
 *    reported alongside it so a human can reconcile.
 *  - `key` makes each step traceable in the rollback report.
 */

import { logger } from "../../observability/logger";

export interface SagaStep<T = unknown> {
  /** Short, stable identifier used in logs + the rollback report. */
  key: string;
  /** Perform the step. Its return value is passed to `undo` for compensation. */
  run: () => Promise<T>;
  /** Compensate the step. Omit for reads / irreversible sends. */
  undo?: (result: T) => Promise<void>;
}

/**
 * Wrap a typed step so a heterogeneous list can be passed to `runSaga` while each
 * step's `undo` still receives its own `run` result with the right type.
 */
export function sagaStep<T>(s: SagaStep<T>): SagaStep<unknown> {
  return {
    key: s.key,
    run: s.run as () => Promise<unknown>,
    undo: s.undo ? (r: unknown) => s.undo!(r as T) : undefined,
  };
}

export class SagaError extends Error {
  constructor(
    message: string,
    /** The step that failed. */
    readonly failedStep: string,
    /** Steps successfully rolled back, in the order they were compensated. */
    readonly rolledBack: string[],
    /** Steps whose compensation ALSO failed — these need manual reconciliation. */
    readonly compensationFailures: { key: string; error: string }[],
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SagaError";
  }
}

/**
 * Run steps in order. On the first failure, roll back everything already committed
 * (reverse order) and throw a SagaError describing exactly what was undone.
 */
export async function runSaga(workflow: string, steps: SagaStep<unknown>[]): Promise<void> {
  // Each entry pairs a completed step with the value its `run` produced.
  const completed: { step: SagaStep<unknown>; result: unknown }[] = [];

  for (const step of steps) {
    try {
      const result = await step.run();
      completed.push({ step, result });
    } catch (err) {
      const rolledBack: string[] = [];
      const compensationFailures: { key: string; error: string }[] = [];

      // Compensate in reverse (LIFO) — the most recent change is undone first.
      for (let i = completed.length - 1; i >= 0; i--) {
        const { step: done, result } = completed[i];
        if (!done.undo) continue; // read-only or irreversible — nothing to undo
        try {
          await done.undo(result);
          rolledBack.push(done.key);
        } catch (undoErr) {
          compensationFailures.push({ key: done.key, error: String(undoErr) });
        }
      }

      logger.error("[saga] workflow failed — rolled back", {
        workflow,
        failedStep: step.key,
        rolledBack,
        compensationFailures,
        err: String(err),
      });

      throw new SagaError(
        `"${workflow}" failed at step "${step.key}" and was rolled back.`,
        step.key,
        rolledBack,
        compensationFailures,
        err,
      );
    }
  }
}

/** Human-readable outcome for a failed saga (surfaced to the user in the chat/confirm UI). */
export function describeSagaFailure(err: SagaError): string {
  const parts = [`${err.message}`];
  if (err.rolledBack.length > 0) {
    parts.push(`Rolled back: ${err.rolledBack.join(", ")} — no partial data was left behind.`);
  }
  if (err.compensationFailures.length > 0) {
    parts.push(
      `⚠️ Could NOT roll back: ${err.compensationFailures.map((f) => f.key).join(", ")}. These need manual cleanup.`,
    );
  }
  return parts.join(" ");
}
