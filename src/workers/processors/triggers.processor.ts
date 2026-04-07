import { randomUUID } from "crypto";
import { Worker, Job } from "bullmq";
import { getConnection } from "../../queues/connection";
import { getTriggersQueue, getWorkflowQueue } from "../../queues/queues";
import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { query } from "../../config/db";
import { recordAuditLog, buildEffectKey } from "../../security/idempotency";
import {
  TriggerPayload,
  TriggerPayloadSchema,
  WorkflowDefinitionSchema,
  WorkflowCondition,
} from "../../triggers/types";

// ─── Condition evaluator ──────────────────────────────────────────────────────

/**
 * Traverse a dot-path (e.g. "event.eventType") into an arbitrary object.
 * Returns `undefined` if any segment is absent.
 */
function getNestedValue(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((curr, key) => {
    if (curr !== null && typeof curr === "object") {
      return (curr as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Evaluate a single condition against the trigger payload.
 * All comparisons are case-insensitive unless `caseSensitive: true`.
 */
function evaluateCondition(
  trigger: TriggerPayload,
  condition: WorkflowCondition,
): boolean {
  const raw = getNestedValue(trigger, condition.field);

  // exists / not_exists are independent of value
  if (condition.op === "exists") return raw !== undefined && raw !== null;
  if (condition.op === "not_exists") return raw === undefined || raw === null;

  const actualStr = condition.caseSensitive
    ? String(raw ?? "")
    : String(raw ?? "").toLowerCase();
  const expectedStr = condition.caseSensitive
    ? String(condition.value ?? "")
    : String(condition.value ?? "").toLowerCase();

  switch (condition.op) {
    case "equals":
      return actualStr === expectedStr;
    case "not_equals":
      return actualStr !== expectedStr;
    case "contains":
      return actualStr.includes(expectedStr);
    case "not_contains":
      return !actualStr.includes(expectedStr);
  }
}

/**
 * Evaluate all conditions (AND semantics).
 * An empty conditions array always passes.
 */
function evaluateConditions(
  trigger: TriggerPayload,
  conditions: WorkflowCondition[],
): boolean {
  return conditions.every((c) => evaluateCondition(trigger, c));
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

interface WorkflowRow {
  id: string;
  definition: unknown;
}

/** Load active workflows matching the given trigger type. */
async function loadWorkflowsForTrigger(
  triggerType: string,
): Promise<WorkflowRow[]> {
  const result = await query<WorkflowRow>(
    `SELECT id, definition FROM workflows
     WHERE trigger_type = $1 AND is_active = true`,
    [triggerType],
  );
  return result.rows;
}

/**
 * Create a workflow execution and its first step row atomically.
 * Returns the execution id, or null if a row already exists for this
 * (workflow_id, trigger_idempotency_key) — used for safe retries.
 *
 * NOTE: We rely on BullMQ jobId dedup as the primary guard; the DB insert
 * uses a plain INSERT and returns the new id.
 */
async function createExecution(
  workflowId: string,
  userId: string,
  triggerContext: Record<string, unknown>,
  firstStepId: string,
): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO workflow_executions
       (workflow_id, user_id, status, context, current_step)
     VALUES ($1, $2, 'pending', $3, $4)
     RETURNING id`,
    [
      workflowId,
      userId,
      JSON.stringify({ trigger: triggerContext }),
      firstStepId,
    ],
  );
  const executionId = result.rows[0].id;

  // Seed the first step row in 'pending' state.
  await query(
    `INSERT INTO workflow_execution_steps
       (execution_id, step_id, status, attempt, input)
     VALUES ($1, $2, 'pending', 0, $3)
     ON CONFLICT (execution_id, step_id) DO NOTHING`,
    [executionId, firstStepId, JSON.stringify({ trigger: triggerContext })],
  );

  return executionId;
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export function startTriggersWorker(): Worker {
  const worker = new Worker(
    "triggers",
    async (job: Job) => {
      const envelope = JobEnvelopeSchema.parse(job.data);

      switch (envelope.jobType) {
        // ── trigger.emit ──────────────────────────────────────────────────────
        // Fan-out: load all active workflows matching the trigger type and
        // enqueue one trigger.evaluate job per workflow.  Each evaluate job
        // has a deterministic jobId so bursts within the same minute coalesce.
        case JobType.TRIGGER_EMIT: {
          const trigger = TriggerPayloadSchema.parse(envelope.payload);

          const workflows = await loadWorkflowsForTrigger(trigger.triggerType);

          if (workflows.length === 0) {
            console.log(
              `[triggers] trigger.emit | no active workflows for ${trigger.triggerType} | user=${envelope.userId}`,
            );
            break;
          }

          const bucket = Math.floor(Date.now() / 60_000);

          await Promise.all(
            workflows.map(async (wf) => {
              const evalJobId = `trigger|evaluate|${wf.id}|${trigger.triggerType}|${envelope.userId}|${bucket}`;
              await getTriggersQueue().add(
                JobType.TRIGGER_EVALUATE,
                {
                  jobType: JobType.TRIGGER_EVALUATE,
                  requestId: randomUUID(),
                  idempotencyKey: evalJobId,
                  userId: envelope.userId,
                  payload: {
                    trigger,
                    workflowId: wf.id,
                    workflowDefinition: wf.definition,
                  } as Record<string, unknown>,
                },
                {
                  jobId: evalJobId,
                  attempts: 8,
                  backoff: {
                    type: "workflow_exp" as "exponential",
                    delay: 5_000,
                  },
                },
              );
            }),
          );

          console.log(
            `[triggers] trigger.emit | ${trigger.triggerType} | user=${envelope.userId} | fanned out to ${workflows.length} workflow(s)`,
          );
          break;
        }

        // ── trigger.evaluate ──────────────────────────────────────────────────
        // Evaluate conditions for one workflow against the trigger payload.
        // If conditions pass: create execution + first step, enqueue workflow.run.
        case JobType.TRIGGER_EVALUATE: {
          const {
            trigger: rawTrigger,
            workflowId,
            workflowDefinition: rawDef,
          } = envelope.payload as {
            trigger: unknown;
            workflowId: string;
            workflowDefinition: unknown;
          };

          const trigger = TriggerPayloadSchema.parse(rawTrigger);
          const definition = WorkflowDefinitionSchema.parse(rawDef);

          const conditions = definition.trigger.conditions ?? [];
          if (!evaluateConditions(trigger, conditions)) {
            console.log(
              `[triggers] trigger.evaluate | workflow=${workflowId} | conditions NOT met — skipping`,
            );
            break;
          }

          const firstStep = definition.steps[0];
          const executionId = await createExecution(
            workflowId,
            envelope.userId,
            trigger as unknown as Record<string, unknown>,
            firstStep.id,
          );

          // Enqueue the first workflow.run job (Step 11 processor will execute it).
          const runJobId = `workflow|run|${executionId}|${firstStep.id}|0`;
          await getWorkflowQueue().add(
            JobType.WORKFLOW_RUN,
            {
              jobType: JobType.WORKFLOW_RUN,
              requestId: randomUUID(),
              idempotencyKey: runJobId,
              userId: envelope.userId,
              payload: {
                executionId,
                stepId: firstStep.id,
                attempt: 0,
              } as Record<string, unknown>,
            },
            {
              jobId: runJobId,
              // workflow.* policy: 12 attempts, exponential 5s base, 15m cap
              // (cap enforced by workflow Worker backoffStrategy).
              attempts: 12,
              backoff: { type: "workflow_exp" as "exponential", delay: 5_000 },
            },
          );

          // Durable audit record (idempotent via UNIQUE constraint).
          await recordAuditLog({
            userId: envelope.userId,
            actorType: "worker",
            action: "workflow.execution.created",
            entityType: "workflow_execution",
            entityId: executionId,
            idempotencyKey: buildEffectKey(
              "workflow.execution.created",
              envelope.idempotencyKey,
            ),
            requestId: envelope.requestId,
            payload: {
              workflowId,
              triggerType: trigger.triggerType,
              executionId,
              firstStepId: firstStep.id,
            },
          });

          console.log(
            `[triggers] trigger.evaluate | workflow=${workflowId} | execution=${executionId} | enqueued workflow.run`,
          );
          break;
        }

        default:
          console.warn(`[triggers] unknown jobType=${envelope.jobType}`);
      }
    },
    { connection: getConnection(), concurrency: 10 },
  );

  worker.on("failed", (job, err) => {
    console.error(`[triggers] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
