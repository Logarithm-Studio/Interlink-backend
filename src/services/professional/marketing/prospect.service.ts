import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { withTransaction } from "../../../config/db";
import { getKey } from "../../../security/keyring";
import { AppError, BadRequestError } from "../../../utils/errors";
import { executeComposioTool } from "../../composio/composio.service";
import { getContact } from "../sales/sales.service";
import { normalizeProspects, ProspectSchema, type Prospect } from "./prospect.model";

export const ProspectSearchSchema = z.object({
  provider: z.enum(["hubspot", "salesforce"]),
  query: z.string().trim().min(2).max(100),
  title: z.string().trim().max(100).optional(),
});
const PreviewSchema = z.object({ userId: z.string().uuid(), expires: z.number(), prospect: ProspectSchema });

function signPreview(userId: string, prospect: Prospect): string {
  const { kid, key } = getKey();
  const payload = Buffer.from(JSON.stringify({ userId, expires: Date.now() + 15 * 60_000, prospect })).toString("base64url");
  return `${kid}.${payload}.${createHmac("sha256", key).update(`prospect:${payload}`).digest("base64url")}`;
}

function readPreview(userId: string, token: string): Prospect {
  try {
    const [kid, payload, signature, extra] = token.split(".");
    if (!kid || !payload || !signature || extra) throw new Error();
    const expected = createHmac("sha256", getKey(kid).key).update(`prospect:${payload}`).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const preview = PreviewSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    if (preview.userId !== userId || preview.expires < Date.now()) throw new Error();
    return preview.prospect;
  } catch { throw new BadRequestError("This prospect preview has expired or changed. Search again before importing."); }
}

export async function searchCrmProspects(userId: string, input: z.infer<typeof ProspectSearchSchema>) {
  const title = input.title?.trim();
  const args = input.provider === "hubspot"
    ? { query: input.query, limit: 25, properties: ["firstname", "lastname", "email", "company", "jobtitle"],
      ...(title ? { filterGroups: [{ filters: [{ propertyName: "jobtitle", operator: "CONTAINS_TOKEN", value: title }] }] } : {}) }
    : { company: input.query, ...(title ? { title } : {}), limit: 25, fields: "Id,Name,Email,Company,Title" };
  const response = await executeComposioTool(userId, input.provider === "hubspot" ? "HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA" : "SALESFORCE_SEARCH_LEADS", args);
  if (!response.ok) throw new AppError(response.message, 502);
  try {
    return normalizeProspects(input.provider, response.data).map((prospect) => ({ ...prospect, importToken: signPreview(userId, prospect) }));
  } catch (error) { throw new AppError(error instanceof Error ? error.message : "Couldn't read CRM prospects.", 502); }
}

/** Serialize imports per user. A repeated preview returns the same contact without overwrites. */
export async function importCrmProspect(userId: string, token: string) {
  const prospect = readPreview(userId, token);
  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`marketing-prospect-import:${userId}`]);
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM sales_contacts WHERE user_id=$1 AND
       ((marketing_attribution->>'crmProvider'=$2 AND marketing_attribution->>'crmRecordId'=$3)
         OR ($4::text IS NOT NULL AND lower(email)=lower($4))) ORDER BY created_at LIMIT 1`,
      [userId, prospect.provider, prospect.externalId, prospect.email],
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, alreadyImported: true };
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO sales_contacts(user_id,name,email,company,title,source,marketing_opt_in,marketing_attribution)
       VALUES($1,$2,$3,$4,$5,$6,false,$7::jsonb) RETURNING id`,
      [userId, prospect.name, prospect.email, prospect.company, prospect.title, `${prospect.provider}_research`,
        JSON.stringify({ crmProvider: prospect.provider, crmRecordId: prospect.externalId })],
    );
    return { id: inserted.rows[0].id, alreadyImported: false };
  });
  return { contact: await getContact(userId, result.id), alreadyImported: result.alreadyImported };
}
