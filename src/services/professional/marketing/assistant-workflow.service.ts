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
  description: "Read owned Marketing contacts, research plans, open follow-ups, content, email sequences or agreements. Use query or recordId to find contacts/research plans beyond the first page; cursor continues those lists using nextCursor from the response. Other resources return recent records only. Resolve exact contact IDs before saving a research plan. Content bodies are excerpts of up to 2000 characters. Never sends, exports or schedules.",
  parameters: { type: "object", properties: { resource: { type: "string", enum: ["contacts", "research_plans", "followups", "content", "email_sequences", "agreements"] }, query: { type: "string" }, recordId: { type: "string" }, cursor: { type: "object", properties: { createdAt: { type: "string" }, id: { type: "string" } }, required: ["createdAt", "id"] } }, required: ["resource"] },
}, {
  name: "create_marketing_research_plan",
  description: "Save a reviewed research shortlist and objective in Interlink. Use exact owned contact IDs from read_marketing_workspace; never invent contacts. Does not export or send outreach. Exporting to Notion or Todoist requires a separate export_marketing_research_plan review after this step succeeds.",
  parameters: { type: "object", properties: { title: { type: "string" }, objective: { type: "string" }, contactIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25 } }, required: ["title", "objective", "contactIds"] },
}, {
  name: "read_marketing_destinations",
  description: "Discover actual accessible Notion parent pages or Todoist projects for a research-plan export. Use the returned exact ID; never invent a destination. Read only.",
  parameters: { type: "object", properties: { provider: { type: "string", enum: ["notion", "todoist"] }, query: { type: "string", description: "Optional destination title search." } }, required: ["provider"] },
}, {
  name: "export_marketing_research_plan",
  description: "Export an existing owned research plan to one discovered Notion parent page or Todoist project. Requires its own human review of the actual destination, objective and contacts. Reuses existing export receipts; uncertain writes require manual reconciliation, never blind retries. Discover exact plan and destination IDs first. No outreach is sent.",
  parameters: { type: "object", properties: { planId: { type: "string" }, provider: { type: "string", enum: ["notion", "todoist"] }, destinationId: { type: "string" }, query: { type: "string", description: "The destination search used for discovery, if any." } }, required: ["planId", "provider", "destinationId"] },
}];

const DestinationInput = z.object({ provider: z.enum(["notion", "todoist"]), query: z.string().trim().max(120).optional() });
const ExportInput = DestinationInput.extend({ planId: z.string().uuid(), destinationId: z.string().trim().min(1).max(200) });

export async function readMarketingDestinations(userId: string, args: Record<string, unknown>) {
  const { researchPlanDestinations } = await import("./research-plan.service");
  const input = DestinationInput.parse(args);
  const destinations = (await researchPlanDestinations(userId, input.provider, input.query ?? ""))
    .filter(row => !input.query || row.title.toLowerCase().includes(input.query.toLowerCase())).slice(0, 30);
  const data = { provider: input.provider, destinations, limit: 30, source: "Connected provider" };
  return { message: JSON.stringify(data), data };
}

export function validateMarketingExport(args: Record<string, unknown>): string | null {
  return ExportInput.safeParse(args).success ? null : "Read owned research plans and read_marketing_destinations first. Use their exact plan UUID and destination ID, with provider notion or todoist. Nothing was exported.";
}

export async function reviewMarketingExport(userId: string, args: Record<string, unknown>) {
  const { previewResearchPlan, researchPlanDestinations } = await import("./research-plan.service");
  const input = ExportInput.parse(args);
  const preview = await previewResearchPlan(userId, input.planId);
  const destination = (await researchPlanDestinations(userId, input.provider, input.query ?? "")).find(row => row.id === input.destinationId);
  if (!destination) throw new AppError("Choose a destination available in your connected account.", 400);
  return { ...input, title: preview.plan.title, objective: preview.plan.objective, destination: destination.title,
    contacts: preview.contacts.map(contact => [contact.name, contact.title, contact.company, contact.email].filter(Boolean).join(" - ")).join("\n"), fingerprint: preview.fingerprint };
}

export async function exportMarketingResearchPlan(userId: string, args: Record<string, unknown>) {
  const { exportResearchPlan } = await import("./research-plan.service");
  const input = ExportInput.extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).parse(args);
  const exports = (await exportResearchPlan(userId, input.planId, input.provider, input.destinationId, input.fingerprint))
    .filter(row => row.provider === input.provider && row.destination_id === input.destinationId);
  const ok = exports.length > 0 && exports.every(row => row.status === "synced");
  return { ok, message: ok ? `Research plan copied to ${input.provider}; existing copies were retained. No outreach was sent.` : "The export needs provider review in Research & planning. Check the existing receipt before retrying; a copy may already exist.",
    data: { planId: input.planId, provider: input.provider, exports: exports.map(row => ({ id: row.id, status: row.status, externalId: row.external_id, url: row.external_url })) } };
}

export async function readMarketingWorkspace(userId: string, args: Record<string, unknown>): Promise<{ message: string; data: unknown }> {
  const { resource, query: search, recordId, cursor } = z.object({ resource: z.enum(["contacts", "research_plans", "followups", "content", "email_sequences", "agreements"]), query: z.string().trim().max(120).optional(), recordId: z.string().uuid().optional(), cursor: z.object({ createdAt: z.iso.datetime({ offset: true }), id: z.string().uuid() }).optional() }).parse(args);
  if (resource === "contacts" || resource === "research_plans") {
    const limit = resource === "contacts" ? 25 : 20;
    // Identifiers are fixed here; all model-supplied values remain SQL parameters.
    const table = resource === "contacts" ? "sales_contacts" : "sales_marketing_research_plans";
    const columns = resource === "contacts" ? 'id,name,email,company,title,marketing_opt_in AS "marketingOptIn"' : 'id,title,objective,contact_ids';
    const searchable = resource === "contacts" ? "concat_ws(' ',name,email,company,title)" : "concat_ws(' ',title,objective)";
    // A JS Date truncates microseconds and can skip records sharing a cursor millisecond.
    const found = await query<{ id: string; createdAt: string }>(`SELECT ${columns},to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM ${table}
      WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2)
        AND ($3::text IS NULL OR strpos(lower(${searchable}),lower($3))>0)
        AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $6`, [userId, recordId ?? null, search || null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]);
    const records = found.rows.slice(0, limit), last = records.at(-1);
    const data = { resource, records, limit, hasMore: found.rows.length > limit, nextCursor: found.rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null, source: "Interlink owned Marketing records" };
    return { message: JSON.stringify(data), data };
  }
  if (search || recordId || cursor) throw new AppError("Search and pagination are available for contacts and research plans. Other resources return recent records only.", 400);
  let records: unknown[];
  if (resource === "email_sequences") {
    const { listEmailSequences } = await import("./email-sequence.service");
    records = (await listEmailSequences(userId)).slice(0, 20).map(row => ({ id: row.id, contactId: row.contact_id, recipient: row.recipient_email, status: row.status, nextStep: row.next_step, dueAt: row.due_at, stepCount: row.steps.length, lastError: row.last_error }));
  } else if (resource === "followups") {
    const { listMarketingFollowups } = await import("./leads.service");
    records = (await listMarketingFollowups(userId)).slice(0, 20).map(row => ({ id: row.id, title: row.title, contactName: row.contactName, status: row.status, dueAt: row.dueAt, todoistTaskId: row.todoistTaskId }));
  } else if (resource === "content") {
    const { listMarketingContent } = await import("./content.service");
    records = (await listMarketingContent(userId)).slice(0, 20).map(row => ({ id: row.id, campaignId: row.campaignId, title: row.title, channel: row.channel, body: row.body.slice(0, 2000), bodyTruncated: row.body.length > 2000, status: row.status, scheduledAt: row.scheduledAt, publishedAt: row.publishedAt, providerItemId: row.providerItemId }));
  } else {
    const { listAgreements } = await import("./agreement.service");
    records = (await listAgreements(userId)).slice(0, 20).map(row => ({ id: row.id, title: row.title, status: row.status, signerName: row.signer_name, signerEmail: row.signer_email, envelopeId: row.envelope_id }));
  }
  const data = { resource, records, limit: 20, source: "Interlink owned Marketing records" };
  return { message: JSON.stringify(data), data };
}

export async function saveMarketingResearchPlan(userId: string, args: Record<string, unknown>) {
  const { createResearchPlan, ResearchPlanInput } = await import("./research-plan.service");
  const plan = await createResearchPlan(userId, ResearchPlanInput.parse(args));
  return { ok: true, message: `Saved research plan "${plan.title}" with ${plan.contact_ids.length} selected contacts in Interlink. No external copy was made. Review Notion or Todoist destinations in Research & planning.`, data: { planId: plan.id, title: plan.title, objective: plan.objective, contactIds: plan.contact_ids } };
}

export async function validateMarketingResearchPlan(args: Record<string, unknown>): Promise<string | null> {
  const { ResearchPlanInput } = await import("./research-plan.service");
  return ResearchPlanInput.safeParse(args).success ? null : "Research plan identifiers or details are invalid. Read read_marketing_workspace with resource contacts and use its exact owned UUID contact IDs, not names or invented identifiers. Include the requested title and objective. Nothing in this batch was saved or executed.";
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
