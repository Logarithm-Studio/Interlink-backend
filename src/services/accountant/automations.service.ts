/**
 * Accountant automations service (Professional Mode, iter3).
 * CRUD for automation rules (autonomy + guardrails) and per-client dunning pause.
 */

import { query } from "../../config/db";

export type AutomationType =
  | "dunning_sequence"
  | "expense_audit"
  | "flash_report"
  | "tax_docs";
export type AutonomyLevel = "off" | "suggest" | "auto";

export interface Automation {
  id: string;
  type: AutomationType;
  enabled: boolean;
  autonomy: AutonomyLevel;
  config: Record<string, unknown>;
  guardrails: Record<string, unknown>;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
}

interface AutomationRow {
  id: string;
  type: AutomationType;
  enabled: boolean;
  autonomy: AutonomyLevel;
  config: Record<string, unknown> | null;
  guardrails: Record<string, unknown> | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
}

/** Defaults seeded the first time a user opens automations (safe = Suggest). */
const DEFAULTS: Record<
  AutomationType,
  { autonomy: AutonomyLevel; config: Record<string, unknown>; guardrails: Record<string, unknown> }
> = {
  dunning_sequence: {
    autonomy: "suggest",
    config: { cadenceDays: 5 },
    guardrails: { dailySendCap: 20, businessHoursOnly: true, maxEscalation: "final" },
  },
  expense_audit: { autonomy: "suggest", config: { everyDays: 7 }, guardrails: {} },
  flash_report: { autonomy: "suggest", config: { weekday: 1 }, guardrails: {} },
  tax_docs: { autonomy: "off", config: { thresholdCents: 60000 }, guardrails: {} },
};

const TYPES = Object.keys(DEFAULTS) as AutomationType[];

function mapRow(r: AutomationRow): Automation {
  return {
    id: r.id,
    type: r.type,
    enabled: r.enabled,
    autonomy: r.autonomy,
    config: r.config ?? {},
    guardrails: r.guardrails ?? {},
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
  };
}

/** Ensure all default automation rows exist, then return them. */
export async function getAutomations(userId: string): Promise<Automation[]> {
  for (const type of TYPES) {
    const d = DEFAULTS[type];
    await query(
      `INSERT INTO accountant_automations (user_id, type, autonomy, config, guardrails)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (user_id, type) DO NOTHING`,
      [userId, type, d.autonomy, JSON.stringify(d.config), JSON.stringify(d.guardrails)],
    );
  }
  const res = await query<AutomationRow>(
    `SELECT id, type, enabled, autonomy, config, guardrails, next_run_at, last_run_at
       FROM accountant_automations WHERE user_id = $1 ORDER BY type`,
    [userId],
  );
  return res.rows.map(mapRow);
}

export async function getAutomation(
  userId: string,
  type: AutomationType,
): Promise<Automation | null> {
  const res = await query<AutomationRow>(
    `SELECT id, type, enabled, autonomy, config, guardrails, next_run_at, last_run_at
       FROM accountant_automations WHERE user_id = $1 AND type = $2`,
    [userId, type],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function updateAutomation(
  userId: string,
  type: AutomationType,
  patch: {
    enabled?: boolean;
    autonomy?: AutonomyLevel;
    config?: Record<string, unknown>;
    guardrails?: Record<string, unknown>;
  },
): Promise<Automation> {
  const d = DEFAULTS[type];
  // Ensure the row exists with defaults first (idempotent).
  await query(
    `INSERT INTO accountant_automations (user_id, type, autonomy, config, guardrails)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     ON CONFLICT (user_id, type) DO NOTHING`,
    [userId, type, d.autonomy, JSON.stringify(d.config), JSON.stringify(d.guardrails)],
  );

  // Update only the provided fields.
  const sets: string[] = [];
  const params: unknown[] = [userId, type];
  let i = 3;
  if (patch.enabled !== undefined) {
    sets.push(`enabled = $${i++}`);
    params.push(patch.enabled);
  }
  if (patch.autonomy !== undefined) {
    sets.push(`autonomy = $${i++}`);
    params.push(patch.autonomy);
  }
  if (patch.config !== undefined) {
    sets.push(`config = $${i++}::jsonb`);
    params.push(JSON.stringify(patch.config));
  }
  if (patch.guardrails !== undefined) {
    sets.push(`guardrails = $${i++}::jsonb`);
    params.push(JSON.stringify(patch.guardrails));
  }
  sets.push("updated_at = now()");

  const res = await query<AutomationRow>(
    `UPDATE accountant_automations SET ${sets.join(", ")}
      WHERE user_id = $1 AND type = $2
      RETURNING id, type, enabled, autonomy, config, guardrails, next_run_at, last_run_at`,
    params,
  );
  return mapRow(res.rows[0]);
}

// ─── Per-client settings ──────────────────────────────────────────────────────

export async function listClientSettings(
  userId: string,
): Promise<{ clientName: string; dunningPaused: boolean }[]> {
  const res = await query<{ client_name: string; dunning_paused: boolean }>(
    `SELECT client_name, dunning_paused FROM accountant_client_settings WHERE user_id = $1`,
    [userId],
  );
  return res.rows.map((r) => ({ clientName: r.client_name, dunningPaused: r.dunning_paused }));
}

export async function setClientDunningPaused(
  userId: string,
  clientName: string,
  paused: boolean,
): Promise<void> {
  await query(
    `INSERT INTO accountant_client_settings (user_id, client_name, dunning_paused)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, client_name)
     DO UPDATE SET dunning_paused = $3, updated_at = now()`,
    [userId, clientName, paused],
  );
}

export async function isClientDunningPaused(
  userId: string,
  clientName: string,
): Promise<boolean> {
  const res = await query<{ dunning_paused: boolean }>(
    `SELECT dunning_paused FROM accountant_client_settings
      WHERE user_id = $1 AND client_name = $2`,
    [userId, clientName],
  );
  return res.rows[0]?.dunning_paused ?? false;
}
