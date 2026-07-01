/**
 * Import professional data from a Google Sheet (reuses the HR Sheets client).
 * The first row is treated as headers; each subsequent row becomes one entity in
 * the current persona's primary collection. Header names are matched loosely.
 */

import { readSheetRange } from "../hr/sheets.service";
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

export async function importSheet(
  userId: string,
  persona: string,
  spreadsheetId: string,
  range = "A1:Z1000",
): Promise<{ imported: number }> {
  const rows = await readSheetRange(userId, spreadsheetId, range);
  const records = toRecords(rows);
  let imported = 0;

  for (const rec of records) {
    if (persona === "sales") {
      const name = pick(rec, "name", "contact", "full name");
      if (!name) continue;
      await createContact(userId, { name, email: pick(rec, "email"), company: pick(rec, "company", "account"), title: pick(rec, "title", "role"), source: "sheet" });
      imported++;
    } else if (persona === "customer_support") {
      const subject = pick(rec, "subject", "issue", "title");
      if (!subject) continue;
      await createTicket(userId, { subject, body: pick(rec, "body", "message", "description"), customerName: pick(rec, "customer", "name", "customer name"), customerEmail: pick(rec, "email", "customer email"), priority: (pick(rec, "priority") as TicketPriority) ?? "medium", source: "sheet" });
      imported++;
    } else if (persona === "real_estate") {
      const name = pick(rec, "name", "lead", "client");
      if (!name) continue;
      await createLead(userId, { name, email: pick(rec, "email"), phone: pick(rec, "phone"), interest: pick(rec, "interest", "notes"), source: "sheet" });
      imported++;
    } else if (persona === "hr") {
      const name = pick(rec, "name", "candidate");
      if (!name) continue;
      await createCandidate(userId, { name, email: pick(rec, "email"), role: pick(rec, "role", "position"), source: "sheet" });
      imported++;
    }
  }
  return { imported };
}
