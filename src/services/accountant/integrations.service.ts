/**
 * Accountant ↔ connected-app sync (Slack push + Notion push/pull).
 *
 * Gated on the integration being connected; degrades to a friendly "connect X"
 * message otherwise. Reuses the flash-report generator, the invoice CRUD, and
 * the existing Slack/Notion services.
 */

import { AppUser } from "../../types";
import { recordActivity } from "./activity.service";
import { isConnected } from "../integrations/tokenStore";
import { getChannels, postMessage } from "../slack/slack.service";
import { searchPages, createPage, queryDatabase } from "../notion/notion.service";
import { getFlashReport } from "./reporting.service";
import { createInvoice } from "./invoices.service";

const PERSONA = "finance";
type Result = { ok: boolean; message: string };

function flashReportText(report: {
  summary: string; cashRunwayNote: string; insights: string[]; recommendations: string[];
}): string {
  return [
    report.summary,
    "",
    report.cashRunwayNote,
    "",
    "Insights:",
    ...report.insights.map((i) => `• ${i}`),
    "",
    "Recommended actions:",
    ...report.recommendations.map((r) => `• ${r}`),
  ].join("\n");
}

async function resolveSlackChannel(userId: string, channel?: string): Promise<string | null> {
  const target = (channel ?? "").trim();
  if (target) {
    if (/^[CG][A-Z0-9]/.test(target)) return target;
    const clean = target.replace(/^#/, "").toLowerCase();
    const match = (await getChannels(userId)).find((c) => c.name.toLowerCase() === clean);
    return match?.id ?? null;
  }
  const channels = await getChannels(userId);
  return (channels.find((c) => c.isMember) ?? channels[0])?.id ?? null;
}

// ─── Push: flash report → Slack ─────────────────────────────────────────────────

export async function postFlashReportToSlack(user: AppUser, channel?: string): Promise<Result> {
  if (!(await isConnected(user.id, "slack"))) return { ok: false, message: "Connect Slack in Settings → Manage Integrations to post the report." };
  const target = await resolveSlackChannel(user.id, channel);
  if (!target) return { ok: false, message: "No Slack channel is available to post to." };

  const { report } = await getFlashReport(user.id);
  const title = `*Flash Financial Report — ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" })}*`;
  await postMessage(user.id, target, `${title}\n${flashReportText(report)}`);

  await recordActivity({ userId: user.id, persona: PERSONA, kind: "flash_report_slack", title: "Posted flash report to Slack" });
  return { ok: true, message: "Posted your flash financial report to Slack." };
}

// ─── Push: flash report → Notion page ───────────────────────────────────────────

export async function exportFlashReportToNotion(user: AppUser, parentId?: string): Promise<Result> {
  if (!(await isConnected(user.id, "notion"))) return { ok: false, message: "Connect Notion in Settings → Manage Integrations to export the report." };
  const parent = parentId?.trim() || (await searchPages(user.id, ""))[0]?.id;
  if (!parent) return { ok: false, message: "Share a Notion page with the Interlink integration so I can nest the report under it." };

  const { report } = await getFlashReport(user.id);
  const title = `Flash Financial Report — ${new Date().toISOString().slice(0, 10)}`;
  const page = await createPage(user.id, { parentId: parent, title, content: flashReportText(report) });

  await recordActivity({ userId: user.id, persona: PERSONA, kind: "flash_report_notion", title: "Exported flash report to Notion" });
  return { ok: true, message: page.url ? `Exported the flash report to Notion (${page.url}).` : "Exported the flash report to Notion." };
}

// ─── Pull: Notion database → invoices ───────────────────────────────────────────

/** Best-effort extraction of an invoice from a Notion database row. */
function parseInvoiceRow(row: Record<string, unknown>): { clientName: string; amountCents: number; dueDate?: string } | null {
  const props = (row.properties ?? {}) as Record<string, { type?: string; title?: { plain_text?: string }[]; rich_text?: { plain_text?: string }[]; number?: number | null; date?: { start?: string } | null }>;
  let clientName = "";
  let amountCents = 0;
  let dueDate: string | undefined;

  for (const [name, prop] of Object.entries(props)) {
    const lname = name.toLowerCase();
    if (prop.type === "title" && !clientName) {
      clientName = (prop.title ?? []).map((t) => t.plain_text ?? "").join("").trim();
    } else if (prop.type === "number" && (lname.includes("amount") || lname.includes("total") || lname.includes("price") || amountCents === 0)) {
      if (typeof prop.number === "number") amountCents = Math.round(prop.number * 100);
    } else if (prop.type === "date" && !dueDate && prop.date?.start) {
      dueDate = prop.date.start.slice(0, 10);
    }
  }
  if (!clientName || amountCents <= 0) return null;
  return { clientName, amountCents, dueDate };
}

export async function importInvoicesFromNotion(user: AppUser, databaseId: string): Promise<Result> {
  if (!(await isConnected(user.id, "notion"))) return { ok: false, message: "Connect Notion in Settings → Manage Integrations to import invoices." };
  const rows = await queryDatabase(user.id, databaseId);
  if (rows.length === 0) return { ok: false, message: "That Notion database is empty or isn't shared with the integration." };

  let imported = 0;
  for (const row of rows) {
    const parsed = parseInvoiceRow(row as Record<string, unknown>);
    if (!parsed) continue;
    try {
      await createInvoice(user.id, { clientName: parsed.clientName, amountCents: parsed.amountCents, dueDate: parsed.dueDate });
      imported++;
    } catch { /* skip a row */ }
  }

  await recordActivity({ userId: user.id, persona: PERSONA, kind: "invoices_notion_import", title: `Imported ${imported} invoice(s) from Notion` });
  return { ok: true, message: imported > 0 ? `Imported ${imported} invoice(s) from Notion.` : "No importable rows found — each row needs a title (client) and a number (amount)." };
}
