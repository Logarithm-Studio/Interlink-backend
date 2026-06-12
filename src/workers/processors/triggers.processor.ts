import { randomUUID } from "crypto";
import { JobEnvelopeSchema, JobType } from "../../jobs/schemas/envelope";
import { query } from "../../config/db";
import { recordAuditLog, buildEffectKey } from "../../security/idempotency";
import { enqueueJob } from "../../services/jobQueue.service";
import {
  TriggerPayload,
  TriggerPayloadSchema,
  WorkflowDefinitionSchema,
  WorkflowCondition,
} from "../../triggers/types";

// ─── Condition evaluator ──────────────────────────────────────────────────────

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((curr, key) => {
    if (curr !== null && typeof curr === "object") {
      return (curr as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function evaluateCondition(
  trigger: TriggerPayload,
  condition: WorkflowCondition,
): boolean {
  const raw = getNestedValue(trigger, condition.field);

  if (condition.op === "exists") return raw !== undefined && raw !== null;
  if (condition.op === "not_exists") return raw === undefined || raw === null;

  const actualStr = condition.caseSensitive
    ? String(raw ?? "")
    : String(raw ?? "").toLowerCase();
  const expectedStr = condition.caseSensitive
    ? String(condition.value ?? "")
    : String(condition.value ?? "").toLowerCase();

  switch (condition.op) {
    case "equals":      return actualStr === expectedStr;
    case "not_equals":  return actualStr !== expectedStr;
    case "contains":    return actualStr.includes(expectedStr);
    case "not_contains": return !actualStr.includes(expectedStr);
  }
}

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

async function loadWorkflowsForTrigger(triggerType: string): Promise<WorkflowRow[]> {
  const result = await query<WorkflowRow>(
    `SELECT id, definition FROM workflows WHERE trigger_type = $1 AND is_active = true`,
    [triggerType],
  );
  return result.rows;
}

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
    [workflowId, userId, JSON.stringify({ trigger: triggerContext }), firstStepId],
  );
  const executionId = result.rows[0].id;

  await query(
    `INSERT INTO workflow_execution_steps
       (execution_id, step_id, status, attempt, input)
     VALUES ($1, $2, 'pending', 0, $3)
     ON CONFLICT (execution_id, step_id) DO NOTHING`,
    [executionId, firstStepId, JSON.stringify({ trigger: triggerContext })],
  );

  return executionId;
}

// ─── Processor ────────────────────────────────────────────────────────────────

export async function processTriggersJob(
  rawData: unknown,
  jobId: string,
): Promise<void> {
  const envelope = JobEnvelopeSchema.parse(rawData);

  switch (envelope.jobType) {
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
          await enqueueJob(
            "triggers",
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
            { jobId: evalJobId, retries: 8 },
          );
        }),
      );

      console.log(
        `[triggers] trigger.emit | ${trigger.triggerType} | user=${envelope.userId} | fanned out to ${workflows.length} workflow(s)`,
      );
      break;
    }

    case JobType.TRIGGER_EVALUATE: {
      const { trigger: rawTrigger, workflowId, workflowDefinition: rawDef } =
        envelope.payload as {
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

      const runJobId = `workflow|run|${executionId}|${firstStep.id}|0`;
      await enqueueJob(
        "workflow",
        {
          jobType: JobType.WORKFLOW_RUN,
          requestId: randomUUID(),
          idempotencyKey: runJobId,
          userId: envelope.userId,
          payload: { executionId, stepId: firstStep.id, attempt: 0 } as Record<string, unknown>,
        },
        { jobId: runJobId, retries: 12 },
      );

      await recordAuditLog({
        userId: envelope.userId,
        actorType: "worker",
        action: "workflow.execution.created",
        entityType: "workflow_execution",
        entityId: executionId,
        idempotencyKey: buildEffectKey("workflow.execution.created", envelope.idempotencyKey),
        requestId: envelope.requestId,
        payload: { workflowId, triggerType: trigger.triggerType, executionId, firstStepId: firstStep.id },
      });

      console.log(
        `[triggers] trigger.evaluate | workflow=${workflowId} | execution=${executionId} | enqueued workflow.run`,
      );
      break;
    }

    default:
      console.warn(`[triggers] unknown jobType=${envelope.jobType} | job=${jobId}`);
  }
}
