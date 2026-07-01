/**
 * HR vertical (Professional Mode) — includes merged Recruiter.
 * Candidates + job openings data model, demo seed, AI snapshot, and agentic tools.
 */

import { query } from "../../../config/db";
import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { sendProfessionalEmail } from "../email";
import { draftEmail } from "../draft";
import { geminiGenerateContent, isGeminiLive } from "../../ai/geminiClient";
import type { GeminiToolFunction } from "../../ai/geminiClient";
import type { PersonaVertical } from "../registry";

const PERSONA = "hr";

export type CandidateStage = "applied" | "screening" | "interview" | "offer" | "hired" | "rejected";

export interface Candidate {
  id: string; name: string; email: string | null; role: string | null;
  stage: CandidateStage; score: number | null; resumeText: string | null; source: string; createdAt: Date;
}
export interface Opening {
  id: string; title: string; department: string | null; location: string | null; status: string; source: string; createdAt: Date;
}

export async function listCandidates(userId: string): Promise<Candidate[]> {
  const res = await query(
    `SELECT id, name, email, role, stage, score, resume_text, source, created_at
       FROM hr_candidates WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(mapCandidate as never);
}
export async function createCandidate(userId: string, data: { name: string; email?: string; role?: string; stage?: CandidateStage; resumeText?: string; source?: string }): Promise<Candidate> {
  const res = await query(
    `INSERT INTO hr_candidates (user_id, name, email, role, stage, resume_text, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, name, email, role, stage, score, resume_text, source, created_at`,
    [userId, data.name, data.email ?? null, data.role ?? null, data.stage ?? "applied", data.resumeText ?? null, data.source ?? "manual"]);
  return mapCandidate(res.rows[0] as never);
}
export async function updateCandidate(userId: string, id: string, patch: { stage?: CandidateStage; score?: number }): Promise<Candidate | null> {
  const res = await query(
    `UPDATE hr_candidates SET stage = COALESCE($3, stage), score = COALESCE($4, score), updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING id, name, email, role, stage, score, resume_text, source, created_at`,
    [id, userId, patch.stage ?? null, patch.score ?? null]);
  return res.rows[0] ? mapCandidate(res.rows[0] as never) : null;
}
export async function listOpenings(userId: string): Promise<Opening[]> {
  const res = await query(
    `SELECT id, title, department, location, status, source, created_at
       FROM hr_openings WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return res.rows.map(mapOpening as never);
}
export async function createOpening(userId: string, data: { title: string; department?: string; location?: string; status?: string; source?: string }): Promise<Opening> {
  const res = await query(
    `INSERT INTO hr_openings (user_id, title, department, location, status, source)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, title, department, location, status, source, created_at`,
    [userId, data.title, data.department ?? null, data.location ?? null, data.status ?? "open", data.source ?? "manual"]);
  return mapOpening(res.rows[0] as never);
}

export async function seedDemo(userId: string): Promise<{ count: number }> {
  const existing = await query<{ n: string }>(`SELECT COUNT(*) n FROM hr_candidates WHERE user_id = $1`, [userId]);
  if (parseInt(existing.rows[0]?.n ?? "0", 10) > 0) return { count: 0 };
  await createOpening(userId, { title: "Senior Frontend Engineer", department: "Engineering", location: "Remote", source: "demo" });
  await createOpening(userId, { title: "Product Designer", department: "Design", location: "NYC", source: "demo" });
  const cands: { name: string; email: string; role: string; stage: CandidateStage; resumeText: string }[] = [
    { name: "Alex Kim", email: "alex@example.com", role: "Senior Frontend Engineer", stage: "screening", resumeText: "6 years React/TypeScript, led design systems, ex-Stripe." },
    { name: "Bella Ortiz", email: "bella@example.com", role: "Product Designer", stage: "interview", resumeText: "Product designer, 5 years, Figma, shipped 0->1 mobile apps." },
    { name: "Chris Doyle", email: "chris@example.com", role: "Senior Frontend Engineer", stage: "applied", resumeText: "3 years Vue, some React, bootcamp grad, strong CSS." },
  ];
  for (const c of cands) await createCandidate(userId, { ...c, source: "demo" });
  return { count: cands.length + 2 };
}

async function buildSnapshot(userId: string): Promise<string> {
  const [cands, openings] = await Promise.all([listCandidates(userId), listOpenings(userId)]);
  const active = cands.filter((c) => c.stage !== "hired" && c.stage !== "rejected");
  return [
    `Open roles: ${openings.filter((o) => o.status === "open").length}. Active candidates: ${active.length}.`,
    "Openings:",
    ...openings.slice(0, 10).map((o) => `- ${o.title} | ${o.department ?? "—"} | ${o.location ?? "—"} | ${o.status}`),
    "Candidates:",
    ...cands.slice(0, 20).map((c) => `- ${c.name} | ${c.role ?? "—"} | stage=${c.stage}${c.score != null ? ` | score=${c.score}` : ""} | ${c.email ?? "no-email"}`),
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are the user's AI HR & recruiting assistant inside the Interlink app.",
  "Answer questions about candidates/openings using ONLY the DATA SNAPSHOT, or perform ONE action by calling a function when asked.",
  "Never invent people. You never send anything yourself — the app confirms before executing.",
].join("\n");

const TOOLS: GeminiToolFunction[] = [
  { name: "add_candidate", description: "Add a candidate to the pipeline.", parameters: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, role: { type: "string" } }, required: ["name"] } },
  { name: "screen_resume", description: "AI-score a candidate's resume against their target role (0-100) and set their score.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "advance_candidate", description: "Move a candidate to a new stage.", parameters: { type: "object", properties: { name: { type: "string" }, stage: { type: "string", enum: ["applied", "screening", "interview", "offer", "hired", "rejected"] } }, required: ["name", "stage"] } },
  { name: "draft_outreach", description: "Draft and send an outreach/scheduling email to a candidate.", parameters: { type: "object", properties: { name: { type: "string" }, note: { type: "string" } }, required: ["name"] } },
];

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "add_candidate": return `Add candidate ${args.name ?? ""}.`;
    case "screen_resume": return `AI-screen ${args.name ?? "candidate"}'s resume.`;
    case "advance_candidate": return `Move ${args.name ?? "candidate"} to ${args.stage}.`;
    case "draft_outreach": return `Draft & send outreach to ${args.name ?? "candidate"}.`;
    default: return `Run ${name}.`;
  }
}

async function scoreResume(resume: string, role: string): Promise<number> {
  if (!isGeminiLive()) return 60;
  try {
    const result = await geminiGenerateContent({
      system: `You are a technical recruiter. Score the resume's fit for the role from 0-100. Return ONLY JSON: {"score": number}.`,
      parts: [{ text: `Role: ${role}\nResume: ${resume}` }],
      json: true,
      maxOutputTokens: 200,
    });
    const obj = JSON.parse(result.raw) as { score?: unknown };
    const s = typeof obj.score === "number" ? obj.score : 60;
    return Math.max(0, Math.min(100, Math.round(s)));
  } catch {
    return 60;
  }
}

async function executeTool(user: AppUser, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    switch (name) {
      case "add_candidate": {
        const c = await createCandidate(user.id, { name: String(args.name ?? "").trim(), email: args.email ? String(args.email) : undefined, role: args.role ? String(args.role) : undefined, source: "assistant" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "candidate_added", title: `Added candidate ${c.name}`, entityType: "hr_candidate", entityId: c.id });
        return { ok: true, message: `Added ${c.name}.` };
      }
      case "screen_resume": {
        const cands = await listCandidates(user.id);
        const c = cands.find((x) => x.name.toLowerCase() === String(args.name ?? "").toLowerCase());
        if (!c) return { ok: false, message: "Couldn't find that candidate." };
        const score = await scoreResume(c.resumeText ?? "", c.role ?? "the role");
        await updateCandidate(user.id, c.id, { score, stage: c.stage === "applied" ? "screening" : c.stage });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "resume_screened", title: `Screened ${c.name}: ${score}/100`, entityType: "hr_candidate", entityId: c.id });
        return { ok: true, message: `${c.name} scored ${score}/100 for ${c.role ?? "the role"}.` };
      }
      case "advance_candidate": {
        const cands = await listCandidates(user.id);
        const c = cands.find((x) => x.name.toLowerCase() === String(args.name ?? "").toLowerCase());
        if (!c) return { ok: false, message: "Couldn't find that candidate." };
        await updateCandidate(user.id, c.id, { stage: args.stage as CandidateStage });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "candidate_advanced", title: `${c.name} → ${args.stage}`, entityType: "hr_candidate", entityId: c.id });
        return { ok: true, message: `Moved ${c.name} to ${args.stage}.` };
      }
      case "draft_outreach": {
        const cands = await listCandidates(user.id);
        const c = cands.find((x) => x.name.toLowerCase() === String(args.name ?? "").toLowerCase());
        if (!c) return { ok: false, message: "Couldn't find that candidate." };
        if (!c.email) return { ok: false, message: `No email on file for ${c.name}.` };
        const draft = await draftEmail({ role: "recruiter", purpose: "a friendly outreach email inviting the candidate to a next step", context: `Candidate: ${c.name}, applying for ${c.role ?? "a role"}. ${args.note ? `Note: ${args.note}` : ""}` });
        await sendProfessionalEmail({ user, to: c.email, subject: draft.subject, body: draft.body, tag: "hr_outreach" });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "outreach_sent", title: `Outreach sent to ${c.name}`, detail: draft.subject, entityType: "hr_candidate", entityId: c.id });
        return { ok: true, message: `Outreach sent to ${c.name}.` };
      }
      default:
        return { ok: false, message: `Unsupported action: ${name}.` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function mapCandidate(r: { id: string; name: string; email: string | null; role: string | null; stage: CandidateStage; score: number | null; resume_text: string | null; source: string; created_at: Date }): Candidate {
  return { id: r.id, name: r.name, email: r.email, role: r.role, stage: r.stage, score: r.score, resumeText: r.resume_text, source: r.source, createdAt: r.created_at };
}
function mapOpening(r: { id: string; title: string; department: string | null; location: string | null; status: string; source: string; created_at: Date }): Opening {
  return { id: r.id, title: r.title, department: r.department, location: r.location, status: r.status, source: r.source, createdAt: r.created_at };
}

export const hrVertical: PersonaVertical = {
  persona: PERSONA,
  tools: TOOLS,
  systemPrompt: SYSTEM_PROMPT,
  buildSnapshot,
  executeTool,
  summarizeAction,
  seedDemo,
};
