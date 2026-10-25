import { z } from "zod";

export const ProspectSchema = z.object({
  provider: z.enum(["hubspot", "salesforce"]),
  externalId: z.string().min(1).max(100),
  name: z.string().min(1).max(300),
  email: z.string().email().max(320).nullable(),
  company: z.string().max(300).nullable(),
  title: z.string().max(300).nullable(),
});
export type Prospect = z.infer<typeof ProspectSchema>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit = 300): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;

/** Reject unknown response shapes rather than claiming a search found no prospects. */
export function normalizeProspects(provider: Prospect["provider"], payload: unknown): Prospect[] {
  let value = object(payload);
  let rows: unknown[] | undefined;
  for (let depth = 0; depth < 4; depth++) {
    rows = [value.results, value.records, value.leads, value.contacts].find(Array.isArray);
    if (rows) break;
    value = object(value.data);
  }
  if (!rows) throw new Error("The CRM returned an unrecognized search response. No records were imported.");
  return rows.slice(0, 25).flatMap((row) => {
    const item = object(row);
    const fields = provider === "hubspot" ? object(item.properties) : item;
    const externalId = text(provider === "hubspot" ? item.id : item.Id, 100);
    if (!externalId) return [];
    const rawEmail = text(provider === "hubspot" ? fields.email : fields.Email, 320);
    const email = z.string().email().safeParse(rawEmail).success ? rawEmail : null;
    const name = provider === "hubspot" ? [text(fields.firstname), text(fields.lastname)].filter(Boolean).join(" ") : text(fields.Name);
    return [{ provider, externalId, name: (name || email || "Unnamed prospect").slice(0, 300), email,
      company: text(provider === "hubspot" ? fields.company : fields.Company),
      title: text(provider === "hubspot" ? fields.jobtitle : fields.Title) }];
  });
}
