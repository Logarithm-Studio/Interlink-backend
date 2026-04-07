/**
 * Workflow DB service — reads execution and workflow rows needed by the engine.
 *
 * All writes go through `src/workflow/state.ts`; this file is read-only.
 */

import { query } from "../config/db";
import {
  WorkflowDefinitionSchema,
  WorkflowDefinition,
} from "../workflow/definition";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExecutionRow {
  id: string;
  workflowId: string;
  userId: string;
  status: "pending" | "running" | "waiting" | "completed" | "failed";
  context: Record<string, unknown>;
  currentStep: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRow {
  id: string;
  name: string;
  triggerType: string;
  definition: WorkflowDefinition;
  isActive: boolean;
}

export interface StepRow {
  id: string;
  executionId: string;
  stepId: string;
  status: "pending" | "running" | "waiting" | "completed" | "failed";
  attempt: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  nextRunAt: Date | null;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Load an execution row by id.
 * Returns `null` if not found.
 */
export async function getExecution(
  executionId: string,
): Promise<ExecutionRow | null> {
  const result = await query<{
    id: string;
    workflow_id: string;
    user_id: string;
    status: string;
    context: Record<string, unknown>;
    current_step: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, workflow_id, user_id, status, context, current_step, created_at, updated_at
     FROM workflow_executions
     WHERE id = $1`,
    [executionId],
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return {
    id: r.id,
    workflowId: r.workflow_id,
    userId: r.user_id,
    status: r.status as ExecutionRow["status"],
    context: r.context ?? {},
    currentStep: r.current_step,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Load a workflow row (with parsed definition).
 * Returns `null` if not found.
 */
export async function getWorkflow(
  workflowId: string,
): Promise<WorkflowRow | null> {
  const result = await query<{
    id: string;
    name: string;
    trigger_type: string;
    definition: unknown;
    is_active: boolean;
  }>(
    `SELECT id, name, trigger_type, definition, is_active
     FROM workflows
     WHERE id = $1`,
    [workflowId],
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  const definition = WorkflowDefinitionSchema.parse(r.definition);
  return {
    id: r.id,
    name: r.name,
    triggerType: r.trigger_type,
    definition,
    isActive: r.is_active,
  };
}

/**
 * Load a step row by (executionId, stepId).
 * Returns `null` if not found.
 */
export async function getStep(
  executionId: string,
  stepId: string,
): Promise<StepRow | null> {
  const result = await query<{
    id: string;
    execution_id: string;
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
    `SELECT id, execution_id, step_id, status, attempt, input, output, error,
            started_at, finished_at, next_run_at
     FROM workflow_execution_steps
     WHERE execution_id = $1 AND step_id = $2`,
    [executionId, stepId],
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return {
    id: r.id,
    executionId: r.execution_id,
    stepId: r.step_id,
    status: r.status as StepRow["status"],
    attempt: r.attempt,
    input: r.input ?? {},
    output: r.output ?? {},
    error: r.error ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    nextRunAt: r.next_run_at,
  };
}
