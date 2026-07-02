/**
 * Professional-persona automation config (Suggest/Auto), keyed by persona.
 * Definitions live on each vertical (`registry.ts` AutomationDef); rows in
 * `professional_automations` hold the per-user enabled/autonomy state.
 */

import { query } from "../../config/db";
import { getVertical } from "./registry";

export type AutonomyLevel = "off" | "suggest" | "auto";

export interface AutomationView {
  type: string;
  title: string;
  description: string;
  enabled: boolean;
  autonomy: AutonomyLevel;
  cadenceDays: number;
  lastRunAt: Date | null;
}

/** Ensure a row exists for each of the persona's defined automations, then list them. */
export async function getProfessionalAutomations(
  userId: string,
  persona: string,
): Promise<AutomationView[]> {
  const vertical = getVertical(persona);
  const defs = vertical?.automations ?? [];
  for (const d of defs) {
    await query(
      `INSERT INTO professional_automations (user_id, persona, type, autonomy)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, persona, type) DO NOTHING`,
      [userId, persona, d.type, d.defaultAutonomy],
    );
  }
  const res = await query<{ type: string; enabled: boolean; autonomy: AutonomyLevel; last_run_at: Date | null }>(
    `SELECT type, enabled, autonomy, last_run_at FROM professional_automations
      WHERE user_id = $1 AND persona = $2`,
    [userId, persona],
  );
  const stateByType = new Map(res.rows.map((r) => [r.type, r]));
  return defs.map((d) => {
    const s = stateByType.get(d.type);
    return {
      type: d.type,
      title: d.title,
      description: d.description,
      enabled: s?.enabled ?? true,
      autonomy: s?.autonomy ?? d.defaultAutonomy,
      cadenceDays: d.cadenceDays,
      lastRunAt: s?.last_run_at ?? null,
    };
  });
}

export async function updateProfessionalAutomation(
  userId: string,
  persona: string,
  type: string,
  patch: { enabled?: boolean; autonomy?: AutonomyLevel },
): Promise<void> {
  await query(
    `INSERT INTO professional_automations (user_id, persona, type, enabled, autonomy)
     VALUES ($1, $2, $3, COALESCE($4, true), COALESCE($5, 'suggest'))
     ON CONFLICT (user_id, persona, type) DO UPDATE SET
       enabled  = COALESCE($4, professional_automations.enabled),
       autonomy = COALESCE($5, professional_automations.autonomy),
       updated_at = now()`,
    [userId, persona, type, patch.enabled ?? null, patch.autonomy ?? null],
  );
}
