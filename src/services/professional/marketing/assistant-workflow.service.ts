import { z } from "zod";
import { query } from "../../../config/db";
import type { GeminiToolFunction } from "../../ai/geminiClient";
import { AppError } from "../../../utils/errors";

export const MARKETING_TOOLS: GeminiToolFunction[] = [{
  name: "read_marketing_campaigns",
  description: "Read the user's actual saved Interlink campaigns, including exact IDs, draft/delivery status, goals and copy. Use for saved draft questions and after creating a campaign. This reads local records; it never sends or publishes.",
  parameters: { type: "object", properties: { campaignId: { type: "string", description: "Exact saved campaign UUID, if known." }, query: { type: "string", description: "Optional topic or subject phrase to find a campaign." } } },
}, {
  name: "read_marketing_workspace",
  description: "Read owned Marketing contacts, research plans, email sequences or agreements from Interlink. Returns actual record IDs and status; never sends, exports or schedules. Use contacts to resolve exact contact IDs before saving a research plan.",
  parameters: { type: "object", properties: { resource: { type: "string", enum: ["contacts", "research_plans", "email_sequences", "agreements"] } }, required: ["resource"] },
}, {
  name: "create_marketing_research_plan",
  description: "Save a reviewed research shortlist and objective in Interlink. Use exact owned contact IDs from read_marketing_workspace; never invent contacts. Does not export to Notion/Todoist or send outreach. Those destinations require their own review in Research & planning.",
  parameters: { type: "object", properties: { title: { type: "string" }, objective: { type: "string" }, contactIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25 } }, required: ["title", "objective", "contactIds"] },
}];

export async function readMarketingWorkspace(userId: string, args: Record<string, unknown>): Promise<{ message: string; data: unknown }> {
  const { resource } = z.object({ resource: z.enum(["contacts", "research_plans", "email_sequences", "agreements"]) }).parse(args);
  let records: unknown[];
  if (resource === "contacts") {
    const { listContacts } = await import("../sales/sales.service");
    records = (await listContacts(userId)).slice(0, 25);
  } else if (resource === "research_plans") {
    const { listResearchPlans } = await import("./research-plan.service");
    records = (await listResearchPlans(userId)).slice(0, 20);
  } else if (resource === "email_sequences") {
    const { listEmailSequences } = await import("./email-sequence.service");
    records = (await listEmailSequences(userId)).slice(0, 20).map(row => ({ id: row.id, contactId: row.contact_id, recipient: row.recipient_email, status: row.status, nextStep: row.next_step, dueAt: row.due_at, stepCount: row.steps.length, lastError: row.last_error }));
  } else {
    const { listAgreements } = await import("./agreement.service");
    records = (await listAgreements(userId)).slice(0, 20).map(row => ({ id: row.id, title: row.title, status: row.status, signerName: row.signer_name, signerEmail: row.signer_email, envelopeId: row.envelope_id }));
  }
  const data = { resource, records, limit: resource === "contacts" ? 25 : 20, source: "Interlink owned Marketing records" };
  return { message: JSON.stringify(data), data };
}

export async function saveMarketingResearchPlan(userId: string, args: Record<string, unknown>) {
  const { createResearchPlan, ResearchPlanInput } = await import("./research-plan.service");
  const plan = await createResearchPlan(userId, ResearchPlanInput.parse(args));
  return { ok: true, message: `Saved research plan "${plan.title}" with ${plan.contact_ids.length} selected contacts in Interlink. No external copy was made. Review Notion or Todoist destinations in Research & planning.`, data: { planId: plan.id, title: plan.title, objective: plan.objective, contactIds: plan.contact_ids } };
}

/** Resolve review labels from owned records, never model-supplied contact names. */
export async function reviewMarketingResearchPlan(userId: string, args: Record<string, unknown>) {
  const { ResearchPlanInput } = await import("./research-plan.service");
  const input = ResearchPlanInput.parse(args);
  const contactIds = [...new Set(input.contactIds)];
  const found = await query<{ id: string; name: string; email: string | null; company: string | null }>(
    "SELECT id,name,email,company FROM sales_contacts WHERE user_id=$1 AND id=ANY($2::uuid[])", [userId, contactIds]);
  if (found.rows.length !== contactIds.length) throw new AppError("Select only contacts in your workspace.", 400);
  const labels = new Map(found.rows.map(contact => [contact.id, [contact.name, contact.company, contact.email].filter(Boolean).join(" - ")]));
  return { ...input, contactIds, contacts: contactIds.map(id => labels.get(id)).join("\n") };
}

const Input = z.object({ campaignId: z.string().uuid().optional(), query: z.string().trim().max(120).optional() });
export async function readMarketingCampaigns(userId: string, args: Record<string, unknown>): Promise<{ message: string; data: unknown }> {
  const input = Input.parse(args);
  const result = await query(
    `SELECT id,topic,subject,audience,objective,success_metric AS "successMetric",channels,status,
            provider_campaign_id AS "providerCampaignId",sent_count AS "sentCount",
            LEFT(body,CASE WHEN $2::uuid IS NULL THEN 400 ELSE 4000 END) AS "bodyPreview",created_at AS "createdAt"
       FROM sales_marketing_campaigns
      WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2)
        AND ($3::text IS NULL OR topic ILIKE '%' || $3 || '%' OR subject ILIKE '%' || $3 || '%')
      ORDER BY created_at DESC LIMIT 20`, [userId, input.campaignId ?? null, input.query || null]);
  const data = { campaigns: result.rows, limit: 20, source: "Interlink saved campaigns" };
  return { message: JSON.stringify(data), data };
}
