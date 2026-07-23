/**
 * Import professional data into the current persona's primary collection.
 * The first row is treated as headers; each subsequent row becomes one entity.
 * Header names are matched loosely.
 *
 * Two sources feed the SAME mapping (`importRecords`):
 *  - `importSheet` — a Google Sheet (via the HR Sheets client; needs the file in Drive).
 *  - `importFile`  — a directly-attached `.xlsx`/`.xls`/`.csv` (base64, no Drive needed).
 */

import { readSheetRange } from "../hr/sheets.service";
import { parseSpreadsheet } from "./spreadsheet.service";
import { createContact } from "./sales/sales.service";
import { createTicket, type TicketPriority } from "./support/support.service";
import { createLead } from "./realestate/realestate.service";
import { createCandidate } from "./hr/hr.vertical";

function pick(row: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const hit = Object.keys(row).find((h) => h === k);
    if (hit && row[hit]?.trim()) return row[hit].trim();
  }
  return undefined;
}

function toRecords(rows: { values: string[] }[]): Record<string, string>[] {
  if (rows.length < 2) return [];
  const headers = rows[0].values.map((h) => h.toLowerCase().trim());
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => { rec[h] = r.values[i] ?? ""; });
    return rec;
  });
}

/** Personas whose primary collection this importer knows how to populate. */
export const IMPORTABLE_PERSONAS = ["sales", "customer_support", "real_estate", "hr"] as const;
export function isImportablePersona(persona: string): boolean {
  return (IMPORTABLE_PERSONAS as readonly string[]).includes(persona);
}

/** Map already-parsed records into the persona's primary collection. Shared by both sources. */
export async function importRecords(
  userId: string,
  persona: string,
  records: Record<string, string>[],
  source = "sheet",
): Promise<{ imported: number }> {
  let imported = 0;
  for (const rec of records) {
    if (persona === "sales") {
      const name = pick(rec, "name", "contact", "full name");
      if (!name) continue;
      await createContact(userId, { name, email: pick(rec, "email"), company: pick(rec, "company", "account"), title: pick(rec, "title", "role"), source });
      imported++;
    } else if (persona === "customer_support") {
      const subject = pick(rec, "subject", "issue", "title");
      if (!subject) continue;
      await createTicket(userId, { subject, body: pick(rec, "body", "message", "description"), customerName: pick(rec, "customer", "name", "customer name"), customerEmail: pick(rec, "email", "customer email"), priority: (pick(rec, "priority") as TicketPriority) ?? "medium", source });
      imported++;
    } else if (persona === "real_estate") {
      const name = pick(rec, "name", "lead", "client");
      if (!name) continue;
      await createLead(userId, { name, email: pick(rec, "email"), phone: pick(rec, "phone"), interest: pick(rec, "interest", "notes"), source });
      imported++;
    } else if (persona === "hr") {
      const name = pick(rec, "name", "candidate");
      if (!name) continue;
      await createCandidate(userId, { name, email: pick(rec, "email"), role: pick(rec, "role", "position"), source });
      imported++;
    }
  }
  return { imported };
}

export async function importSheet(
  userId: string,
  persona: string,
  spreadsheetId: string,
  range = "A1:Z1000",
): Promise<{ imported: number }> {
  const rows = await readSheetRange(userId, spreadsheetId, range);
  return importRecords(userId, persona, toRecords(rows), "sheet");
}

/**
 * Import a directly-attached spreadsheet (base64 `.xlsx`/`.xls`/`.csv`) — no Google Drive.
 * Parses the bytes locally, then feeds the SAME `importRecords` mapping as the Sheets path.
 */
export async function importFile(
  userId: string,
  persona: string,
  fileBase64: string,
  fileName?: string,
): Promise<{ imported: number; rowCount: number; sheetName: string }> {
  const parsed = parseSpreadsheet(fileBase64, fileName);
  const { imported } = await importRecords(userId, persona, toRecords(parsed.rows), "upload");
  return { imported, rowCount: parsed.rowCount, sheetName: parsed.sheetName };
}
