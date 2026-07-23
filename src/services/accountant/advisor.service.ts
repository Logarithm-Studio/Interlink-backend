/**
 * Financial Advisor service (Professional Mode).
 *
 * The "finance" persona is branded "Financial Advisor" and, on top of the AR/expense
 * engine, gains advisory capabilities from the PRD (#10 Financial Advisor):
 *  - Analyze portfolios  → deterministic allocation + drift analysis (grounds the agent).
 *  - Prepare meeting packets → a per-client briefing emailed to the advisor.
 *  - Track compliance actions → a KYC/suitability/disclosure tracker + resolve.
 *  - Generate client communications → an AI-optional client email, sent via Gmail.
 *
 * Analysis is deterministic (no model call) so numbers are always correct; the client
 * communication reuses the same Gmail draft/send path as the tax W-9 flow.
 */

import { createHash, randomUUID } from "crypto";
import { query } from "../../config/db";
import { AppUser } from "../../types";
import { BadRequestError, NotFoundError } from "../../utils/errors";
import { createGmailDraft, sendGmailDraft } from "../email/gmail.service";
import { recordActivity } from "./activity.service";

export type RiskProfile = "conservative" | "balanced" | "growth" | "aggressive";
export type AssetClass = "equity" | "bond" | "cash" | "alt";
export type ComplianceType = "kyc_refresh" | "suitability_review" | "adv_disclosure" | "rmd" | "beneficiary";
export type ComplianceStatus = "open" | "in_progress" | "done";

const ASSET_CLASSES: AssetClass[] = ["equity", "bond", "cash", "alt"];

/** Target allocation (percent) per risk profile — the baseline drift is measured against. */
const TARGET_ALLOCATION: Record<RiskProfile, Record<AssetClass, number>> = {
  conservative: { equity: 30, bond: 55, cash: 10, alt: 5 },
  balanced: { equity: 55, bond: 35, cash: 5, alt: 5 },
  growth: { equity: 70, bond: 20, cash: 5, alt: 5 },
  aggressive: { equity: 85, bond: 5, cash: 2, alt: 8 },
};

const COMPLIANCE_LABEL: Record<ComplianceType, string> = {
  kyc_refresh: "KYC refresh",
  suitability_review: "Suitability review",
  adv_disclosure: "Form ADV disclosure",
  rmd: "RMD (required minimum distribution)",
  beneficiary: "Beneficiary designation review",
};

export interface AdvisorClient {
  id: string;
  name: string;
  email: string | null;
  riskProfile: RiskProfile;
  notes: string | null;
  aumCents: number;
}

export interface Holding {
  id: string;
  clientId: string;
  symbol: string;
  assetClass: AssetClass;
  valueCents: number;
}

export interface ComplianceItem {
  id: string;
  clientId: string | null;
  clientName: string | null;
  type: ComplianceType;
  title: string;
  dueDate: string | null;
  status: ComplianceStatus;
}

export interface PortfolioAnalysis {
  client: AdvisorClient;
  totalCents: number;
  allocation: Record<AssetClass, { valueCents: number; pct: number; targetPct: number; driftPts: number }>;
  topHoldings: Holding[];
  /** Asset class furthest from target (absolute drift), for talking points. */
  largestDrift: { assetClass: AssetClass; driftPts: number } | null;
  needsRebalance: boolean;
}

const fmtUsd = (cents: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

// ─── Clients + holdings ─────────────────────────────────────────────────────

export async function listClients(userId: string): Promise<AdvisorClient[]> {
  const res = await query<{
    id: string; name: string; email: string | null; risk_profile: RiskProfile; notes: string | null; aum_cents: string | null;
  }>(
    `SELECT c.id, c.name, c.email, c.risk_profile, c.notes,
            COALESCE(SUM(h.value_cents), 0) AS aum_cents
       FROM advisor_clients c
       LEFT JOIN advisor_holdings h ON h.client_id = c.id
      WHERE c.user_id = $1
      GROUP BY c.id
      ORDER BY aum_cents DESC`,
    [userId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    riskProfile: r.risk_profile,
    notes: r.notes,
    aumCents: Number(r.aum_cents ?? 0),
  }));
}

/** Resolve a client by id or a (partial, case-insensitive) name match. */
export async function resolveClient(userId: string, idOrName: string): Promise<AdvisorClient | null> {
  const clients = await listClients(userId);
  const q = idOrName.trim().toLowerCase();
  if (!q) return null;
  return (
    clients.find((c) => c.id === idOrName) ??
    clients.find((c) => c.name.toLowerCase() === q) ??
    clients.find((c) => c.name.toLowerCase().includes(q)) ??
    null
  );
}

async function listHoldings(userId: string, clientId: string): Promise<Holding[]> {
  const res = await query<{ id: string; client_id: string; symbol: string; asset_class: AssetClass; value_cents: string }>(
    `SELECT id, client_id, symbol, asset_class, value_cents
       FROM advisor_holdings WHERE user_id = $1 AND client_id = $2
      ORDER BY value_cents DESC`,
    [userId, clientId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    symbol: r.symbol,
    assetClass: r.asset_class,
    valueCents: Number(r.value_cents),
  }));
}

// ─── Portfolio analysis (deterministic) ─────────────────────────────────────

export async function analyzePortfolio(userId: string, clientRef: string): Promise<PortfolioAnalysis> {
  const client = await resolveClient(userId, clientRef);
  if (!client) throw new NotFoundError(`Client "${clientRef}"`);
  return analyzePortfolioForClient(userId, client);
}

/** Analyze an already-resolved client (avoids re-listing clients in a loop). */
async function analyzePortfolioForClient(userId: string, client: AdvisorClient): Promise<PortfolioAnalysis> {
  const holdings = await listHoldings(userId, client.id);
  const totalCents = holdings.reduce((s, h) => s + h.valueCents, 0);
  const target = TARGET_ALLOCATION[client.riskProfile];

  const allocation = ASSET_CLASSES.reduce((acc, cls) => {
    const valueCents = holdings.filter((h) => h.assetClass === cls).reduce((s, h) => s + h.valueCents, 0);
    const pct = totalCents > 0 ? Math.round((valueCents / totalCents) * 1000) / 10 : 0;
    const targetPct = target[cls];
    acc[cls] = { valueCents, pct, targetPct, driftPts: Math.round((pct - targetPct) * 10) / 10 };
    return acc;
  }, {} as PortfolioAnalysis["allocation"]);

  let largestDrift: PortfolioAnalysis["largestDrift"] = null;
  for (const cls of ASSET_CLASSES) {
    const d = allocation[cls].driftPts;
    if (!largestDrift || Math.abs(d) > Math.abs(largestDrift.driftPts)) largestDrift = { assetClass: cls, driftPts: d };
  }
  const needsRebalance = ASSET_CLASSES.some((cls) => Math.abs(allocation[cls].driftPts) >= 5);

  return { client, totalCents, allocation, topHoldings: holdings.slice(0, 5), largestDrift, needsRebalance };
}

function driftLine(a: PortfolioAnalysis): string {
  return ASSET_CLASSES.map((cls) => {
    const { pct, targetPct } = a.allocation[cls];
    const d = a.allocation[cls].driftPts;
    const sign = d > 0 ? "+" : "";
    return `${cls} ${pct}%/${targetPct}% (${sign}${d}pp)`;
  }).join(", ");
}

// ─── Agent grounding snapshot ───────────────────────────────────────────────

/** Compact advisory-book grounding appended to the finance snapshot. */
export async function buildAdvisorSnapshot(userId: string): Promise<string> {
  const clients = await listClients(userId);
  if (clients.length === 0) return "Advisory book: no clients yet.";

  const totalAum = clients.reduce((s, c) => s + c.aumCents, 0);
  const lines: string[] = [`Advisory book: ${clients.length} client(s), total AUM ${fmtUsd(totalAum)}.`];

  for (const c of clients.slice(0, 10)) {
    const a = await analyzePortfolioForClient(userId, c);
    lines.push(
      `- ${c.name} | ${c.riskProfile} | AUM ${fmtUsd(c.aumCents)} | ${driftLine(a)}${a.needsRebalance ? " | REBALANCE" : ""}`,
    );
  }

  const compliance = await listCompliance(userId, { openOnly: true });
  if (compliance.length > 0) {
    lines.push(`Compliance actions due (${compliance.length}):`);
    for (const item of compliance.slice(0, 10)) {
      lines.push(
        `- ${COMPLIANCE_LABEL[item.type]}${item.clientName ? ` for ${item.clientName}` : ""}${item.dueDate ? ` | due ${item.dueDate}` : ""} | ${item.status}`,
      );
    }
  }
  return lines.join("\n");
}

// ─── Meeting packet ─────────────────────────────────────────────────────────

export function renderMeetingPacket(a: PortfolioAnalysis, compliance: ComplianceItem[]): { subject: string; body: string } {
  const c = a.client;
  const subject = `Meeting packet — ${c.name}`;
  const talkingPoints: string[] = [];
  if (a.needsRebalance && a.largestDrift) {
    const d = a.largestDrift;
    talkingPoints.push(
      `Portfolio has drifted: ${d.assetClass} is ${d.driftPts > 0 ? "over" : "under"} target by ${Math.abs(d.driftPts)}pp — propose a rebalance.`,
    );
  } else {
    talkingPoints.push("Allocation is within tolerance of the target model — reaffirm the plan.");
  }
  if (compliance.length > 0) {
    talkingPoints.push(`Complete ${compliance.length} open compliance item(s): ${compliance.map((i) => COMPLIANCE_LABEL[i.type]).join(", ")}.`);
  }
  talkingPoints.push("Confirm goals, time horizon, and any liquidity needs for the next 12 months.");

  const allocationLines = ASSET_CLASSES.map((cls) => {
    const row = a.allocation[cls];
    return `  • ${cls.padEnd(6)} ${String(row.pct).padStart(5)}%  (target ${row.targetPct}%, drift ${row.driftPts > 0 ? "+" : ""}${row.driftPts}pp)`;
  }).join("\n");

  const body = [
    `Meeting packet for ${c.name}`,
    `Risk profile: ${c.riskProfile} · Assets under management: ${fmtUsd(a.totalCents)}`,
    "",
    "Current allocation vs. target:",
    allocationLines,
    "",
    "Top holdings:",
    ...(a.topHoldings.length ? a.topHoldings.map((h) => `  • ${h.symbol} (${h.assetClass}) — ${fmtUsd(h.valueCents)}`) : ["  • (no holdings on file)"]),
    "",
    "Suggested talking points:",
    ...talkingPoints.map((t, i) => `  ${i + 1}. ${t}`),
    ...(c.notes ? ["", `Advisor notes: ${c.notes}`] : []),
  ].join("\n");

  return { subject, body };
}

export interface MeetingPacketResult {
  clientName: string;
  subject: string;
  body: string;
  emailedTo: string;
}

/** Build the packet and email it to the advisor (the logged-in user). */
export async function prepareMeetingPacket(user: AppUser, clientRef: string): Promise<MeetingPacketResult> {
  const analysis = await analyzePortfolio(user.id, clientRef);
  const compliance = (await listCompliance(user.id, { openOnly: true })).filter(
    (i) => i.clientId === analysis.client.id,
  );
  const { subject, body } = renderMeetingPacket(analysis, compliance);

  const recipients = [user.email.trim().toLowerCase()];
  await sendViaGmail(user.id, `packet:${analysis.client.id}`, recipients, subject, body);

  await recordActivity({
    userId: user.id,
    kind: "meeting_packet_prepared",
    title: `Meeting packet emailed for ${analysis.client.name}`,
    entityType: "advisor_client",
    entityId: analysis.client.id,
    status: "done",
  });

  return { clientName: analysis.client.name, subject, body, emailedTo: recipients[0] };
}

// ─── Client communications ──────────────────────────────────────────────────

export interface ClientCommResult {
  clientName: string;
  recipients: string[];
  subject: string;
  body: string;
}

/** Draft a client-facing update (deterministic template) and send it via Gmail. */
export async function sendClientCommunication(
  user: AppUser,
  clientRef: string,
  topic?: string,
): Promise<ClientCommResult> {
  const analysis = await analyzePortfolio(user.id, clientRef);
  const client = analysis.client;
  if (!client.email?.trim()) throw new BadRequestError(`${client.name} has no email on file.`);

  const heading = (topic ?? "Quarterly portfolio update").trim();
  const advisorName = user.email.split("@")[0] || "Your advisor";
  const performanceNote = analysis.needsRebalance
    ? "Your allocation has drifted from our agreed model, so I'd like to discuss a rebalance at our next meeting."
    : "Your allocation remains in line with our agreed model.";

  const subject = `${heading} — ${client.name}`;
  const body = [
    `Hi ${client.name.split(" ")[0]},`,
    "",
    `Here's your ${heading.toLowerCase()}. Your portfolio is currently valued at ${fmtUsd(analysis.totalCents)}, held in a ${client.riskProfile} allocation.`,
    "",
    performanceNote,
    "",
    "Current mix: " +
      ASSET_CLASSES.map((cls) => `${cls} ${analysis.allocation[cls].pct}%`).join(", ") +
      ".",
    "",
    "If you'd like to review anything or update your goals, just reply and we'll find a time.",
    "",
    "Best regards,",
    advisorName,
  ].join("\n");

  const recipients = [client.email.trim().toLowerCase()];
  await sendViaGmail(user.id, `clientcomm:${client.id}`, recipients, subject, body);

  await recordActivity({
    userId: user.id,
    kind: "client_communication_sent",
    title: `${heading} sent to ${client.name}`,
    entityType: "advisor_client",
    entityId: client.id,
    status: "done",
  });

  return { clientName: client.name, recipients, subject, body };
}

/** Shared Gmail draft+send (mirrors the tax W-9 flow). */
async function sendViaGmail(
  userId: string,
  stepKey: string,
  recipients: string[],
  subject: string,
  body: string,
): Promise<void> {
  const draftKey = `advisor:draft:${userId}:${stepKey}:` + createHash("sha256").update(subject + body).digest("hex").slice(0, 12);
  const draft = await createGmailDraft({
    executionId: null,
    stepId: `advisor:${stepKey}`,
    userId,
    recipients,
    subject,
    body,
    idempotencyKey: draftKey,
  });
  await sendGmailDraft({
    executionId: `advisor:${stepKey}`,
    stepId: `advisor:${stepKey}`,
    userId,
    providerDraftId: draft.providerDraftId,
    idempotencyKey: `advisor:send:${userId}:${stepKey}:${randomUUID()}`,
  });
}

// ─── Compliance tracker ─────────────────────────────────────────────────────

export async function listCompliance(
  userId: string,
  opts: { openOnly?: boolean } = {},
): Promise<ComplianceItem[]> {
  const res = await query<{
    id: string; client_id: string | null; client_name: string | null; type: ComplianceType;
    title: string; due_date: string | null; status: ComplianceStatus;
  }>(
    `SELECT ci.id, ci.client_id, c.name AS client_name, ci.type, ci.title,
            to_char(ci.due_date, 'YYYY-MM-DD') AS due_date, ci.status
       FROM advisor_compliance_items ci
       LEFT JOIN advisor_clients c ON c.id = ci.client_id
      WHERE ci.user_id = $1 ${opts.openOnly ? "AND ci.status <> 'done'" : ""}
      ORDER BY (ci.status = 'done'), ci.due_date NULLS LAST`,
    [userId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    type: r.type,
    title: r.title,
    dueDate: r.due_date,
    status: r.status,
  }));
}

export async function setComplianceStatus(userId: string, id: string, status: ComplianceStatus): Promise<void> {
  const res = await query(
    `UPDATE advisor_compliance_items SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
    [id, userId, status],
  );
  if ((res.rowCount ?? 0) === 0) throw new NotFoundError("Compliance item");
}

/** Mark matching open compliance items done (by client and/or type). Returns what changed. */
export async function resolveCompliance(
  userId: string,
  filter: { clientRef?: string; type?: ComplianceType },
): Promise<{ resolved: number; titles: string[] }> {
  const open = await listCompliance(userId, { openOnly: true });
  let matches = open;
  if (filter.type) matches = matches.filter((i) => i.type === filter.type);
  if (filter.clientRef) {
    const client = await resolveClient(userId, filter.clientRef);
    if (client) matches = matches.filter((i) => i.clientId === client.id);
    else matches = [];
  }
  for (const m of matches) await setComplianceStatus(userId, m.id, "done");
  if (matches.length > 0) {
    await recordActivity({
      userId,
      kind: "compliance_resolved",
      title: `Resolved ${matches.length} compliance item(s)`,
      status: "done",
    });
  }
  return { resolved: matches.length, titles: matches.map((m) => `${COMPLIANCE_LABEL[m.type]}${m.clientName ? ` (${m.clientName})` : ""}`) };
}

export function complianceTypeLabel(type: ComplianceType): string {
  return COMPLIANCE_LABEL[type];
}

// ─── Demo seed ──────────────────────────────────────────────────────────────

/**
 * Load a rich advisory book demo. **Reset-and-reseed**: clears this user's advisor clients,
 * holdings, and compliance items first, then inserts a full book. Resetting also fixes the
 * old duplicate-compliance bug (compliance rows had no uniqueness guard). Idempotent — tap
 * "Load demo" any time for a clean book. Holdings are arranged so several clients show real
 * allocation drift (a "Rebalance" badge) against their risk-profile target.
 */
export async function seedDemoAdvisor(userId: string): Promise<{ clients: number; compliance: number }> {
  // Reset first (holdings/compliance reference clients; delete children then parents).
  await query(`DELETE FROM advisor_compliance_items WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM advisor_holdings WHERE user_id = $1`, [userId]);
  await query(`DELETE FROM advisor_clients WHERE user_id = $1`, [userId]);

  // (name, risk, [ [symbol, class, dollars], ... ])
  const demo: { name: string; risk: RiskProfile; email: string; holdings: [string, AssetClass, number][]; notes?: string }[] = [
    {
      name: "Eleanor Whitfield",
      risk: "conservative",
      email: "eleanor@example.com",
      notes: "Retiring in 3 years; prioritize capital preservation. Allocation on target.",
      holdings: [["VTI", "equity", 210_000], ["BND", "bond", 385_000], ["Cash", "cash", 70_000], ["GLD", "alt", 35_000]],
    },
    {
      name: "Marcus Trent",
      risk: "growth",
      email: "marcus@example.com",
      holdings: [["QQQ", "equity", 520_000], ["VXUS", "equity", 120_000], ["BND", "bond", 90_000], ["Cash", "cash", 20_000]],
    },
    {
      name: "The Okafor Family Trust",
      risk: "balanced",
      email: "okafor@example.com",
      notes: "Two beneficiaries; review designations annually.",
      holdings: [["VOO", "equity", 350_000], ["AGG", "bond", 225_000], ["Cash", "cash", 32_000], ["VNQ", "alt", 33_000]],
    },
    {
      name: "Dr. Priya Anand",
      risk: "aggressive",
      email: "priya@example.com",
      holdings: [["ARKK", "equity", 240_000], ["VUG", "equity", 300_000], ["BTC", "alt", 90_000], ["Cash", "cash", 10_000]],
    },
    {
      name: "Grace Sullivan",
      risk: "growth",
      email: "grace@example.com",
      notes: "Equity-heavy; drifted above target — flag for rebalance.",
      holdings: [["VTI", "equity", 480_000], ["SCHD", "equity", 90_000], ["BND", "bond", 70_000], ["Cash", "cash", 25_000]],
    },
    {
      name: "The Harrison Trust",
      risk: "conservative",
      email: "harrison@example.com",
      notes: "Endowment; quarterly distributions to beneficiaries.",
      holdings: [["BND", "bond", 300_000], ["VTI", "equity", 250_000], ["Cash", "cash", 120_000], ["VNQ", "alt", 30_000]],
    },
  ];

  let clientCount = 0;
  let complianceCount = 0;
  for (const d of demo) {
    const inserted = await query<{ id: string }>(
      `INSERT INTO advisor_clients (user_id, name, email, risk_profile, notes, source)
       VALUES ($1, $2, $3, $4, $5, 'demo')
       ON CONFLICT (user_id, name) DO NOTHING
       RETURNING id`,
      [userId, d.name, d.email, d.risk, d.notes ?? null],
    );
    const clientId = inserted.rows[0]?.id;
    if (!clientId) continue;
    clientCount += 1;
    for (const [symbol, cls, dollars] of d.holdings) {
      await query(
        `INSERT INTO advisor_holdings (user_id, client_id, symbol, asset_class, value_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, clientId, symbol, cls, dollars * 100],
      );
    }
  }

  // Compliance actions, tied to seeded clients where relevant. Due dates are relative to
  // now so the demo always looks current (a couple due soon, one just overdue).
  const dueInDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const clients = await listClients(userId);
  const byName = (n: string) => clients.find((c) => c.name === n)?.id ?? null;
  const complianceSeed: [ComplianceType, string, string | null, string][] = [
    ["kyc_refresh", "Annual KYC refresh", byName("Eleanor Whitfield"), dueInDays(8)],
    ["suitability_review", "Suitability review after risk-profile change", byName("Marcus Trent"), dueInDays(-3)],
    ["beneficiary", "Confirm beneficiary designations", byName("The Okafor Family Trust"), dueInDays(23)],
    ["rmd", "Confirm required minimum distribution", byName("The Harrison Trust"), dueInDays(14)],
    ["kyc_refresh", "KYC refresh — new account", byName("Grace Sullivan"), dueInDays(5)],
    ["adv_disclosure", "Deliver updated Form ADV Part 2", null, dueInDays(-5)],
  ];
  for (const [type, title, clientId, due] of complianceSeed) {
    const res = await query(
      `INSERT INTO advisor_compliance_items (user_id, client_id, type, title, due_date, status)
       VALUES ($1, $2, $3, $4, $5, 'open')`,
      [userId, clientId, type, title, due],
    );
    complianceCount += res.rowCount ?? 0;
  }

  return { clients: clientCount, compliance: complianceCount };
}
