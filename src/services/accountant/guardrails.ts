/**
 * Autonomy guardrails (Professional Mode, iter3).
 * Bound what an Auto-level automation may do for money-adjacent actions (PRD §5).
 */

import { countRemindersSentToday } from "./activity.service";
import { isClientDunningPaused, type Automation } from "./automations.service";

export interface GuardrailDecision {
  allowed: boolean;
  reason?: "client_paused" | "outside_business_hours" | "daily_cap_reached";
}

interface DunningGuardrails {
  dailySendCap?: number;
  businessHoursOnly?: boolean;
  maxEscalation?: "friendly" | "firm" | "final";
}

/** Lenient business-hours window on server local time (8am–8pm). */
export function withinBusinessHours(now = new Date()): boolean {
  const h = now.getHours();
  return h >= 8 && h < 20;
}

/** Cap escalation tone at the automation's `maxEscalation` (default "final"). */
export function capEscalation(
  tone: "friendly" | "firm" | "final",
  guardrails: Record<string, unknown>,
): "friendly" | "firm" | "final" {
  const max = (guardrails as DunningGuardrails).maxEscalation ?? "final";
  const order = ["friendly", "firm", "final"] as const;
  return order.indexOf(tone) > order.indexOf(max) ? max : tone;
}

/** Decide whether an Auto dunning send is permitted right now. */
export async function checkDunningGuardrails(params: {
  userId: string;
  automation: Automation;
  clientName: string;
}): Promise<GuardrailDecision> {
  const g = params.automation.guardrails as DunningGuardrails;

  if (await isClientDunningPaused(params.userId, params.clientName)) {
    return { allowed: false, reason: "client_paused" };
  }
  if (g.businessHoursOnly && !withinBusinessHours()) {
    return { allowed: false, reason: "outside_business_hours" };
  }
  const cap = typeof g.dailySendCap === "number" ? g.dailySendCap : 20;
  if ((await countRemindersSentToday(params.userId)) >= cap) {
    return { allowed: false, reason: "daily_cap_reached" };
  }
  return { allowed: true };
}
