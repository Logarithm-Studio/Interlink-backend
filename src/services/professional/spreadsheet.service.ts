/**
 * Direct spreadsheet parsing — turns an uploaded/attached Excel or CSV file (base64) into
 * rows, WITHOUT going through Google Sheets/Drive. This is the seam that lets a user attach
 * a `.xlsx`/`.csv` in the app and have it imported into the persona book or analyzed by the
 * assistant (Gemini can't read raw xlsx bytes, so we parse to text first).
 *
 * Uses SheetJS (`xlsx`) — a pure-JS, CommonJS-safe parser (no native deps, works on Vercel).
 * The row shape (`{ values: string[] }[]`) is deliberately identical to what
 * `readSheetRange()` returns, so `import.service.ts#toRecords` consumes it unchanged.
 */

import * as XLSX from "xlsx";
import { BadRequestError } from "../../utils/errors";

/** One spreadsheet row, cells stringified/trimmed (mirrors the Sheets client shape). */
export interface SheetRow {
  values: string[];
}

export interface ParsedSpreadsheet {
  sheetName: string;
  /** Includes the header as rows[0]. */
  rows: SheetRow[];
  /** Data rows only (excludes the header row). */
  rowCount: number;
  /** True when the file exceeded MAX_ROWS and was capped. */
  truncated: boolean;
}

/** Hard cap so a huge upload can't blow the request/body limits or the model's context. */
const MAX_ROWS = 1000;

/**
 * Tools that read a spreadsheet from Google Drive. When a sheet is ATTACHED to the message it is
 * NOT in Drive, so these are stripped from the agent's tool list for that turn — the agent then
 * physically cannot fall back to "find a Google Sheet named …" and must act on the attached rows.
 */
export const DRIVE_SHEET_TOOL_NAMES = ["send_bulk_email_from_sheet", "read_sheet", "list_spreadsheets"];

/**
 * Injected FIRST, for ANY attachment (spreadsheet, image, PDF, …). Makes the attached file the
 * subject of the turn so the agent never ignores it or hunts for the data elsewhere (the exact
 * failure behind "couldn't find a Google Sheet named …" when a file was in fact attached).
 */
export const ATTACHMENT_DIRECTIVE =
  "ATTACHMENT PRESENT — the user attached a file to THIS message and it IS the subject of their request. " +
  "Use the attached file (parsed/shown below, or provided inline) as the authoritative source and act on it directly. " +
  "Do NOT search Google Drive / Google Sheets or any other source for this data, do NOT guess or ask for a file/sheet name, " +
  "and do NOT ask the user to upload it somewhere first. If it is a spreadsheet, work from the rows shown and — to email " +
  "people from it — call send_bulk_email with those recipients baked in (filter the rows yourself). If you genuinely cannot " +
  "read the file, say so and ask them to re-attach it; never invent its contents.";

/** Does this attachment look like a spreadsheet we can parse (by mime OR extension)? */
export function isSpreadsheetAttachment(mimeType?: string | null, fileName?: string | null): boolean {
  const mt = (mimeType ?? "").toLowerCase();
  const fn = (fileName ?? "").toLowerCase();
  return (
    mt.includes("spreadsheetml") || // .xlsx (application/vnd.openxmlformats-…-sheet)
    mt.includes("ms-excel") || // .xls
    mt === "text/csv" ||
    mt === "application/csv" ||
    /\.(xlsx|xls|csv)$/.test(fn)
  );
}

/**
 * Parse a base64-encoded spreadsheet (`.xlsx`/`.xls`/`.csv`) into rows. Reads the FIRST sheet.
 * SheetJS auto-detects the format from the bytes, so `fileName` is only used for error context.
 */
export function parseSpreadsheet(base64: string, fileName?: string | null): ParsedSpreadsheet {
  let workbook: XLSX.WorkBook;
  try {
    const buf = Buffer.from(base64, "base64");
    if (buf.length === 0) throw new Error("empty file");
    workbook = XLSX.read(buf, { type: "buffer" });
  } catch (err) {
    throw new BadRequestError(
      `Couldn't read "${fileName ?? "the file"}" as a spreadsheet — make sure it's a valid .xlsx, .xls, or .csv.`,
    );
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { sheetName: "", rows: [], rowCount: 0, truncated: false };

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1, // array-of-arrays; row 0 is the header
    blankrows: false,
    defval: "",
  });

  const allRows: SheetRow[] = aoa.map((r) => ({
    values: (Array.isArray(r) ? r : []).map((c) => (c == null ? "" : String(c).trim())),
  }));
  // Drop fully-empty rows that slipped through (e.g. trailing formatting).
  const nonEmpty = allRows.filter((r) => r.values.some((v) => v !== ""));

  const truncated = nonEmpty.length > MAX_ROWS + 1;
  const rows = truncated ? nonEmpty.slice(0, MAX_ROWS + 1) : nonEmpty;
  return { sheetName, rows, rowCount: Math.max(0, rows.length - 1), truncated };
}

/**
 * Best-effort detection that does NOT trust the mime type or filename — Android's picker often
 * reports `application/octet-stream` and the name can lack an extension, which is exactly why the
 * "email from an attached sheet" flow kept failing. We skip images/audio/video/PDF (those go to the
 * model as inlineData) and then actually TRY to parse the bytes: if it yields a table, it's a
 * spreadsheet. Returns the parsed sheet, or null to fall back to the normal attachment handling.
 */
export function tryParseSpreadsheetAttachment(
  base64: string,
  mimeType?: string | null,
  fileName?: string | null,
): ParsedSpreadsheet | null {
  const mt = (mimeType ?? "").toLowerCase();
  if (mt.startsWith("image/") || mt.startsWith("audio/") || mt.startsWith("video/") || mt === "application/pdf") {
    return null;
  }
  const labelled = isSpreadsheetAttachment(mimeType, fileName);
  try {
    const parsed = parseSpreadsheet(base64, fileName);
    if (parsed.rows.length === 0) return null;
    // If mime/name already says spreadsheet, accept any non-empty parse. Otherwise require a
    // header + at least one data row so an arbitrary text blob isn't mistaken for a sheet.
    return labelled || parsed.rows.length >= 2 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The full context block injected into the agent's prompt for an ATTACHED spreadsheet: the parsed
 * table PLUS explicit steering so the model acts on THESE rows and never routes to a Google-Sheet /
 * Drive tool (the attachment is not a Drive file, and Drive tools would fail to find it). This is the
 * one message that turns "attach a sheet → email these people" into a working flow.
 */
export function spreadsheetContextText(parsed: ParsedSpreadsheet, fileName?: string | null): string {
  return [
    `ATTACHED SPREADSHEET "${fileName ?? (parsed.sheetName || "file")}" — parsed below (row 1 is the header).`,
    `This is the file the user attached to THIS message. It is NOT a Google Sheet in Google Drive, so you`,
    `MUST NOT call send_bulk_email_from_sheet, list_spreadsheets, or read_sheet on it — those look in Drive`,
    `and will fail. Work directly from the rows below:`,
    `• To email people from it: read the matching rows, then call send_bulk_email with those recipients`,
    `  (email + name) baked in — do the date/criteria filtering yourself from the rows here.`,
    `• To add them to the book: use the relevant create tool per row.`,
    ``,
    spreadsheetToText(parsed),
  ].join("\n");
}

/**
 * Render parsed rows as a compact pipe-delimited text table for injecting into an AI prompt
 * (Gemini can't parse xlsx bytes, so the assistant reasons over this text instead of inlineData).
 */
export function spreadsheetToText(parsed: ParsedSpreadsheet, opts: { maxRows?: number } = {}): string {
  const maxRows = opts.maxRows ?? 200;
  if (parsed.rows.length === 0) return "(the spreadsheet is empty)";
  const shown = parsed.rows.slice(0, maxRows + 1); // header + up to maxRows data rows
  const lines = shown.map((r) => r.values.join(" | "));
  const remaining = parsed.rowCount - Math.min(parsed.rowCount, maxRows);
  const footer = remaining > 0 ? `\n… (${remaining} more row${remaining === 1 ? "" : "s"} not shown)` : "";
  return `Sheet "${parsed.sheetName}" — ${parsed.rowCount} data row${parsed.rowCount === 1 ? "" : "s"}:\n${lines.join("\n")}${footer}`;
}
