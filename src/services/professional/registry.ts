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

export interface PersonaVertical {
  persona: string;
  /** Gemini function-calling declarations for this role. */
  tools: GeminiToolFunction[];
  /** Persona system prompt for the agent. */
  systemPrompt: string;
  /** Compact grounding data for the agent. */
  buildSnapshot(userId: string): Promise<string>;
  /** Execute a user-confirmed action. */
  executeTool(user: AppUser, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
  /** Human-readable summary for the confirm card. */
  summarizeAction(name: string, args: Record<string, unknown>): string;
  /** Optional one-tap demo data loader. */
  seedDemo?(userId: string): Promise<{ count: number }>;
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
