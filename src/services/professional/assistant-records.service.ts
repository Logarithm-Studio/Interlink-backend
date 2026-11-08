import { z } from "zod";
import { query } from "../../config/db";
import { AppError } from "../../utils/errors";
import type { GeminiToolFunction } from "../ai/geminiClient";

const RECORDS = {
  candidates: { table: "hr_candidates", columns: 'id,name,email,role,stage,score,left(resume_text,12000) AS "resumeText"', search: "concat_ws(' ',name,email,role)" },
  openings: { table: "hr_openings", columns: "id,title,department,location,status", search: "concat_ws(' ',title,department,location)" },
  tickets: { table: "support_tickets", columns: 'id,subject,priority,status,customer_name AS "customerName",customer_email AS "customerEmail",left(body,4000) AS body', search: "concat_ws(' ',subject,customer_name,customer_email)" },
  leads: { table: "re_leads", columns: 'id,name,email,budget_cents AS "budgetCents",interest,stage', search: "concat_ws(' ',name,email,interest)" },
  listings: { table: "re_listings", columns: 'id,address,price_cents AS "priceCents",currency,beds,baths,status,description', search: "address" },
  leases: { table: "re_leases", columns: 'id,property,tenant_name AS "tenantName",tenant_email AS "tenantEmail",end_date AS "endDate",rent_cents AS "rentCents"', search: "concat_ws(' ',property,tenant_name,tenant_email)" },
  invoices: { table: "invoices", columns: 'id,invoice_number AS "invoiceNumber",client_name AS "clientName",client_email AS "clientEmail",amount_cents AS "amountCents",currency,due_date AS "dueDate",status', search: "concat_ws(' ',invoice_number,client_name,client_email)" },
} as const;
const resources = Object.keys(RECORDS) as [keyof typeof RECORDS, ...(keyof typeof RECORDS)[]];

export const PROFESSIONAL_RECORD_TOOL: GeminiToolFunction = {
  name: "read_professional_records",
  description: "Find exact owned Finance, HR, Support and Real Estate records, including older records absent from the snapshot. Use query, recordId or nextCursor. Resolve duplicate labels with the user; never pick the first. Returns bounded source excerpts, never writes or sends.",
  parameters: { type: "object", properties: { resource: { type: "string", enum: resources }, query: { type: "string" }, recordId: { type: "string" }, cursor: { type: "object", properties: { createdAt: { type: "string" }, id: { type: "string" } }, required: ["createdAt", "id"] } }, required: ["resource"] },
};

export async function readProfessionalRecords(userId: string, args: Record<string, unknown>): Promise<{ message: string; data: unknown }> {
  const input = z.object({ resource: z.enum(resources), query: z.string().trim().max(120).optional(), recordId: z.string().uuid().optional(), cursor: z.object({ createdAt: z.iso.datetime({ offset: true }), id: z.string().uuid() }).optional() }).parse(args);
  const descriptor = RECORDS[input.resource], limit = 25;
  const search = input.query ? `%${input.query.replace(/[\\%_]/g, "\\$&")}%` : null;
  // Table/column identifiers come only from this fixed map; user values stay parameters.
  const found = await query<{ id: string; createdAt: string }>(`SELECT ${descriptor.columns},to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
    FROM ${descriptor.table} WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2)
    AND ($3::text IS NULL OR ${descriptor.search} ILIKE $3 ESCAPE '\\')
    AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT 26`,
    [userId, input.recordId ?? null, search, input.cursor?.createdAt ?? null, input.cursor?.id ?? null]);
  const records = found.rows.slice(0, limit), last = records.at(-1);
  const data = { resource: input.resource, records, hasMore: found.rows.length > limit, nextCursor: found.rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null, source: "Interlink owned Professional records" };
  return { message: JSON.stringify(data), data };
}

export function resolveNamedRecord<T extends { id: string }>(rows: T[], field: keyof T, id: unknown, label: unknown): T {
  const text = String(label ?? "").trim().toLowerCase();
  const exact = text ? rows.filter(row => String(row[field]).toLowerCase() === text) : [];
  const matches = id ? rows.filter(row => row.id === id) : exact.length ? exact : text ? rows.filter(row => String(row[field]).toLowerCase().includes(text)) : [];
  if (matches.length > 1) throw new AppError("Multiple records match. Read the records and ask which exact ID the user wants.", 400);
  if (!matches[0]) throw new AppError("Choose an exact record available in your workspace.", 400);
  return matches[0];
}
