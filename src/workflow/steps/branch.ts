/**
 * `branch` step handler — deterministic conditional routing.
 *
 * Route selection priority:
 * 1. If `resumePayload.actionKey` is set (user-action-driven resume), look it
 *    up in `config.routes` directly.
 * 2. Otherwise, iterate `config.rules` in order.  The first rule whose
 *    `conditions[]` all pass (AND semantics) against the execution context
 *    determines the `routeKey`.  The corresponding `config.routes[routeKey]`
 *    is returned as `nextStepId`.
 * 3. If no rule matches, fall back to `config.defaultNextStepId ?? null`
 *    (null = end of workflow).
 *
 * Conditions use dot-path notation against `executionContext`, allowing steps
 * to branch on previous step outputs via `outputs.<stepId>.<field>`.
 */

import type { StepContext, StepResult } from "../registry";
import type { WorkflowCondition } from "../../triggers/types";

// ─── Dot-path helper ─────────────────────────────────────────────────────────

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((curr, key) => {
    if (curr !== null && typeof curr === "object") {
      return (curr as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// ─── Condition evaluation ────────────────────────────────────────────────────

function evaluateCondition(
  context: Record<string, unknown>,
  condition: WorkflowCondition,
): boolean {
  const raw = getNestedValue(context, condition.field);

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

function evaluateConditions(
  context: Record<string, unknown>,
  conditions: WorkflowCondition[],
): boolean {
  return conditions.every((c) => evaluateCondition(context, c));
}

// ─── Handler ─────────────────────────────────────────────────────────────────

interface BranchConfig {
  routes: Record<string, string>;
  defaultNextStepId?: string | null;
  rules: Array<{
    routeKey: string;
    conditions: WorkflowCondition[];
  }>;
}

export async function branchHandler(ctx: StepContext): Promise<StepResult> {
  const config = ctx.stepDefinition.config as BranchConfig;
  const routes: Record<string, string> = config.routes ?? {};
  const rules = config.rules ?? [];
  const defaultNextStepId: string | null = config.defaultNextStepId ?? null;

  // ── 1. Action-key driven (resume from a user action) ─────────────────────
  const actionKey = ctx.resumePayload?.actionKey as string | undefined;
  if (actionKey) {
    const nextStepId: string | null = routes[actionKey] ?? defaultNextStepId;
    console.log(
      `[workflow:branch] actionKey="${actionKey}" → nextStep=${nextStepId ?? "null"} | execution=${ctx.executionId} step=${ctx.stepId}`,
    );
    return { output: { routeKey: actionKey, via: "action" }, nextStepId };
  }

  // ── 2. Condition-based routing (first matching rule wins) ─────────────────
  for (const rule of rules) {
    if (evaluateConditions(ctx.executionContext, rule.conditions)) {
      const nextStepId: string | null =
        routes[rule.routeKey] ?? defaultNextStepId;
      console.log(
        `[workflow:branch] matched rule routeKey="${rule.routeKey}" → nextStep=${nextStepId ?? "null"} | execution=${ctx.executionId} step=${ctx.stepId}`,
      );
      return {
        output: { routeKey: rule.routeKey, via: "condition" },
        nextStepId,
      };
    }
  }

  // ── 3. Default (no rule matched) ──────────────────────────────────────────
  console.log(
    `[workflow:branch] no rule matched → default nextStep=${defaultNextStepId ?? "null"} | execution=${ctx.executionId} step=${ctx.stepId}`,
  );
  return {
    output: { routeKey: null, via: "default" },
    nextStepId: defaultNextStepId,
  };
}
