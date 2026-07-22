/**
 * Professional persona registry.
 *
 * Each non-finance persona registers a `PersonaVertical` that gives the agentic
 * command center everything it needs to reason + act for that role: a data
 * snapshot, function-calling tools, an action executor, and a demo seed. Finance
 * keeps its bespoke path inside `accountant/assistant.service.ts` and is not
 * listed here.
 */

import type { GeminiToolFunction } from "../ai/geminiClient";
import { AppUser } from "../../types";
import { salesVertical } from "./sales/sales.service";
import { supportVertical } from "./support/support.service";
import { realEstateVertical } from "./realestate/realestate.service";
import { hrVertical } from "./hr/hr.vertical";
import { pmVertical } from "./pm/pm.vertical";

/** A single proposed action produced by an automation's `plan()`. */
export interface AutomationProposal {
  /** User-facing summary, e.g. "Follow up on Acme — annual platform". */
  title: string;
  entityType?: string;
  entityId?: string;
  /** The vertical tool to run (Auto) or offer for approval (Suggest). */
  tool: string;
  args: Record<string, unknown>;
}

/** A scheduled Suggest/Auto automation for a persona (mirrors finance dunning/audit/report). */
export interface AutomationDef {
  type: string;
  title: string;
  description: string;
  /** Minimum days between runs. */
  cadenceDays: number;
  defaultAutonomy: "off" | "suggest" | "auto";
  /** Find the actions this automation would take on this tick. */
  plan(userId: string): Promise<AutomationProposal[]>;
}

export interface PersonaVertical {
  persona: string;
  /** Gemini function-calling declarations for this role. */
  tools: GeminiToolFunction[];
  /** Persona system prompt for the agent. */
  systemPrompt: string;
  /** Compact grounding data for the agent. */
  buildSnapshot(userId: string): Promise<string>;
  /**
   * Execute a user-confirmed action.
   *
   * `message` is the plain-text fallback (used by the assistant chat). `data` is optional
   * STRUCTURED output so the app can render a real UI instead of dumping the message into a
   * `<Text>` — e.g. buyer↔listing matches as cards rather than a wall of bullet characters.
   */
  executeTool(
    user: AppUser,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; message: string; data?: unknown }>;
  /** Human-readable summary for the confirm card. */
  summarizeAction(name: string, args: Record<string, unknown>): string;
  /** Optional one-tap demo data loader. */
  seedDemo?(userId: string): Promise<{ count: number }>;
  /** Optional scheduled autonomy automations. */
  automations?: AutomationDef[];
}

export const VERTICALS: Record<string, PersonaVertical> = {
  sales: salesVertical,
  customer_support: supportVertical,
  real_estate: realEstateVertical,
  hr: hrVertical,
  product_manager: pmVertical,
};

export function getVertical(persona: string): PersonaVertical | undefined {
  return VERTICALS[persona];
}
