import { z } from "zod";
import { createHash } from "node:crypto";
import { query, withTransaction } from "../../../config/db";
import { AppError, NotFoundError } from "../../../utils/errors";
import { searchPages, createPage, getPageContent, assertPageAccessible } from "../../notion/notion.service";
import { getProjects, createTask, getTasks } from "../../todoist/todoist.service";
import { listContacts, type SalesContact } from "../sales/sales.service";

export const ResearchPlanInput = z.object({ title: z.string().trim().min(1).max(200), objective: z.string().trim().min(1).max(4000), contactIds: z.array(z.string().uuid()).min(1).max(25) });
type Plan = { id: string; user_id: string; title: string; objective: string; contact_ids: string[] };
type Export = { id: string; user_id: string; plan_id: string; provider: "notion" | "todoist"; destination_id: string; item_key: string; status: string; external_id: string | null; external_url: string | null };
const marker = (id: string) => `Interlink research export ${id}`;

export async function listResearchPlans(userId: string) { return (await query<Plan>("SELECT * FROM sales_marketing_research_plans WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50", [userId])).rows; }
export async function createResearchPlan(userId: string, raw: z.infer<typeof ResearchPlanInput>) {
  const input = ResearchPlanInput.parse(raw);
  const ids = [...new Set(input.contactIds)];
  return withTransaction(async client => {
    const found = await client.query("SELECT id FROM sales_contacts WHERE user_id=$1 AND id=ANY($2::uuid[])", [userId, ids]);
    if (found.rows.length !== ids.length) throw new AppError("Select only contacts in your workspace.", 400);
    return (await client.query<Plan>("INSERT INTO sales_marketing_research_plans(user_id,title,objective,contact_ids) VALUES($1,$2,$3,$4) RETURNING *", [userId, input.title, input.objective, ids])).rows[0];
  });
}
async function requirePlan(userId: string, id: string) {
  const plan = (await query<Plan>("SELECT * FROM sales_marketing_research_plans WHERE user_id=$1 AND id=$2", [userId, id])).rows[0];
  if (!plan) throw new NotFoundError("Research plan");
  const contacts = (await listContacts(userId)).filter(contact => plan.contact_ids.includes(contact.id)).sort((a,b)=>plan.contact_ids.indexOf(a.id)-plan.contact_ids.indexOf(b.id));
  if (contacts.length !== plan.contact_ids.length) throw new AppError("A selected contact was removed. Create a revised shortlist before exporting.", 409);
  return { plan, contacts };
}
function snapshotFingerprint(plan:Plan,contacts:SalesContact[]) {
  return createHash("sha256").update(JSON.stringify([plan.id,plan.title,plan.objective,contacts.map(c=>[c.id,c.name,c.company,c.title,c.email])])).digest("hex");
}
export async function previewResearchPlan(userId:string,id:string) {
  const {plan,contacts}=await requirePlan(userId,id);
  return {plan,contacts:contacts.map(({id,name,company,title,email})=>({id,name,company,title,email})),fingerprint:snapshotFingerprint(plan,contacts)};
}
export async function listResearchExports(userId: string, planId: string) {
  await requirePlan(userId, planId);
  await query("UPDATE sales_marketing_research_exports SET status='review',updated_at=now() WHERE user_id=$1 AND plan_id=$2 AND status='creating' AND updated_at<now()-interval '20 minutes'", [userId, planId]);
  return (await query<Export>("SELECT * FROM sales_marketing_research_exports WHERE user_id=$1 AND plan_id=$2 ORDER BY created_at", [userId, planId])).rows;
}
export async function researchPlanDestinations(userId: string, provider: "notion" | "todoist", search: string) {
  if (provider === "todoist") return (await getProjects(userId)).map(project => ({ id: project.id, title: project.name }));
  return (await searchPages(userId, search)).map(page => ({ id: page.id, title: page.title }));
}
async function performExport(row: Export, plan: Plan, contacts: SalesContact[]) {
  try {
    let externalId: string; let url: string;
    if (row.provider === "notion") {
      const content = `${plan.objective.replace(/\r?\n/g, " ")}\n\n## Reviewed prospects\n${contacts.map(contact => `- ${[contact.name, contact.title, contact.company, contact.email].filter(Boolean).join(" — ")}`).join("\n")}\n\n${marker(row.id)}`;
      const page = await createPage(row.user_id, { parentId: row.destination_id, title: plan.title, content });
      externalId = page.id; url = page.url;
    } else {
      const contact = contacts.find(item => item.id === row.item_key);
      if (!contact) throw new Error("Missing selected contact");
      const task = await createTask(row.user_id, { projectId: row.destination_id, content: `Research & follow up: ${contact.name}`, description: `${plan.title}\n${plan.objective}\n${[contact.company, contact.title, contact.email].filter(Boolean).join(" · ")}\n${marker(row.id)}` });
      externalId = task.id; url = `https://app.todoist.com/app/task/${encodeURIComponent(task.id)}`;
    }
    if (!externalId) throw new Error("Missing provider ID");
    await query("UPDATE sales_marketing_research_exports SET status='synced',external_id=$3,external_url=$4,updated_at=now() WHERE id=$1 AND user_id=$2 AND status='creating'", [row.id, row.user_id, externalId, url]);
  } catch {
    await query("UPDATE sales_marketing_research_exports SET status='review',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='creating'", [row.id, row.user_id]);
  }
}
export async function exportResearchPlan(userId: string, planId: string, provider: "notion" | "todoist", destinationId: string, expected:string) {
  const { plan, contacts } = await requirePlan(userId, planId);
  if(snapshotFingerprint(plan,contacts)!==expected)throw new AppError("The shortlist changed. Refresh and review the current prospects before exporting.",409);
  if (provider === "todoist") {
    if (!(await getProjects(userId)).some(project => project.id === destinationId)) throw new AppError("Choose a project available in your connected Todoist account.", 400);
  } else { await assertPageAccessible(userId, destinationId); }
  const keys = provider === "notion" ? ["plan"] : contacts.map(contact => contact.id);
  for (const key of keys) {
    const inserted = await query<Export>("INSERT INTO sales_marketing_research_exports(user_id,plan_id,provider,destination_id,item_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(plan_id,provider,destination_id,item_key) DO NOTHING RETURNING *", [userId, planId, provider, destinationId, key]);
    if (inserted.rows[0]) await performExport(inserted.rows[0], plan, contacts);
  }
  return listResearchExports(userId, planId);
}
export async function retryResearchExport(userId:string,id:string,expected:string) {
  const row=(await query<Export>("SELECT * FROM sales_marketing_research_exports WHERE id=$1 AND user_id=$2",[id,userId])).rows[0];
  if(!row||row.status!=="review"||row.external_id)throw new AppError("Choose an unresolved export before confirming a retry.",409);
  const {plan,contacts}=await requirePlan(userId,row.plan_id);
  if(snapshotFingerprint(plan,contacts)!==expected)throw new AppError("Refresh and review the current shortlist before retrying.",409);
  if(row.provider==="notion")await assertPageAccessible(userId,row.destination_id);
  else if(!(await getProjects(userId)).some(p=>p.id===row.destination_id))throw new AppError("The selected Todoist project is no longer available.",409);
  const claimed=await query<Export>("UPDATE sales_marketing_research_exports SET status='creating',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='review' AND external_id IS NULL RETURNING *",[id,userId]);
  if(!claimed.rows[0])throw new AppError("Another request already handled this export.",409);
  await performExport(claimed.rows[0],plan,contacts);
  return listResearchExports(userId,row.plan_id);
}
export async function reconcileResearchExport(userId: string, id: string, externalId: string) {
  const row = (await query<Export>("SELECT * FROM sales_marketing_research_exports WHERE id=$1 AND user_id=$2", [id, userId])).rows[0];
  if (!row || row.status !== "review") throw new AppError("Choose an export awaiting provider review.", 409);
  if (row.provider === "notion") {
    const content = await getPageContent(userId, externalId);
    if (!content.includes(marker(id))) throw new AppError("This Notion page does not contain the matching export marker.", 409);
  } else {
    const task = (await getTasks(userId, row.destination_id)).find(task => task.id === externalId);
    if (!task?.description?.split(/\r?\n/).includes(marker(id))) throw new AppError("This Todoist task does not contain the matching export marker in the selected project.", 409);
  }
  await query("UPDATE sales_marketing_research_exports SET status='synced',external_id=$3,external_url=$4,updated_at=now() WHERE id=$1 AND user_id=$2 AND status='review'", [id, userId, externalId, row.provider === "notion" ? `https://www.notion.so/${externalId.replace(/-/g, "")}` : `https://app.todoist.com/app/task/${encodeURIComponent(externalId)}`]);
  return listResearchExports(userId, row.plan_id);
}
