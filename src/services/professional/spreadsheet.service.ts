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

export interface ParsedWorksheet {
  sheetName: string;
  rows: SheetRow[];
  rowCount: number;
  truncated: boolean;
}

export interface ParsedSpreadsheet {
  sheetName: string;
  /** Includes the header as rows[0]. */
  rows: SheetRow[];
  /** Data rows only (excludes the header row). */
  rowCount: number;
  /** True when the file exceeded MAX_ROWS and was capped. */
  truncated: boolean;
  /** Every non-empty worksheet, capped to the same safe total row budget. */
  worksheets?: ParsedWorksheet[];
}

/** Hard cap so a huge upload can't blow the request/body limits or the model's context. */
const MAX_ROWS = 1000;
export const MAX_BULK_EMAIL_RECIPIENTS = 100;
export const ATTACHED_SPREADSHEET_EMAIL_TOOL_NAME = "send_bulk_email_from_attachment";

/** True when the attachment supplies the recipients (as opposed to "email me a summary"). */
export function requestsSpreadsheetRecipientEmail(message: string): boolean {
  if (/\bemail\s+me\b|\bsend\s+(?:it|this|that|the\s+(?:summary|analysis|report)|a\s+(?:summary|report))\s+to\s+me\b/i.test(message)) {
    return false;
  }
  const sendIntent = /\b(?:send|email|mail)\b/i.test(message);
  const rowRecipients =
    /\b(?:them|everyone|everybody|all\s+(?:people|contacts|recipients|addresses)|those\s+people|these\s+people|people\s+who|recipients?|email\s+addresses?|emails?\s+(?:listed|in|from)|rows?\s+(?:matching|where|with))\b/i.test(
      message,
    );
  return sendIntent && rowRecipients;
}

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
  `people from it — call ${ATTACHED_SPREADSHEET_EMAIL_TOOL_NAME} and describe the requested row filters. The server will ` +
  "select and validate the recipients deterministically from the file. Never put guessed recipients into a mail tool. If you genuinely cannot " +
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
    mt.includes("opendocument.spreadsheet") ||
    mt.includes("sheet.binary.macroenabled") ||
    /\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv)$/.test(fn)
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
    workbook = XLSX.read(buf, { type: "buffer", cellDates: true });
  } catch (err) {
    throw new BadRequestError(
      `Couldn't read "${fileName ?? "the file"}" as a spreadsheet — make sure it's a valid .xlsx, .xls, or .csv.`,
    );
  }

  const worksheets: ParsedWorksheet[] = [];
  let remainingRows = MAX_ROWS + 1;
  let workbookTruncated = false;
  for (const sheetName of workbook.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1, // array-of-arrays; row 0 is the header
      blankrows: false,
      defval: "",
      // Keep the human-visible date value instead of exposing Excel serial numbers to the model.
      // ISO is used when the workbook marks a cell as a date but does not provide a display format.
      raw: false,
      dateNF: "yyyy-mm-dd",
    });
    const nonEmpty: SheetRow[] = aoa
      .map((row) => ({
        values: (Array.isArray(row) ? row : []).map((cell) => (cell == null ? "" : String(cell).trim())),
      }))
      .filter((row) => row.values.some((value) => value !== ""));
    if (!nonEmpty.length) continue;
    if (remainingRows <= 0) {
      workbookTruncated = true;
      break;
    }
    const truncated = nonEmpty.length > remainingRows;
    const rows = truncated ? nonEmpty.slice(0, remainingRows) : nonEmpty;
    worksheets.push({
      sheetName,
      rows,
      rowCount: Math.max(0, rows.length - 1),
      truncated,
    });
    remainingRows -= rows.length;
    workbookTruncated ||= truncated;
  }

  const primary = worksheets[0] ?? { sheetName: "", rows: [], rowCount: 0, truncated: false };
  return {
    ...primary,
    truncated: primary.truncated || workbookTruncated,
    worksheets,
  };
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
  const buf = Buffer.from(base64, "base64");
  const isOleWorkbook =
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const isXlsxZip =
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf.includes(Buffer.from("xl/workbook")) || buf.includes(Buffer.from("xl/worksheets")));
  const textSample = buf.subarray(0, Math.min(buf.length, 32_768)).toString("utf8");
  const nonEmptyLines = textSample.split(/\r?\n/).filter((line) => line.trim()).slice(0, 6);
  const looksLikeCsv =
    nonEmptyLines.length >= 2 &&
    [",", "\t", ";"].some((delimiter) => {
      const counts = nonEmptyLines.map((line) => line.split(delimiter).length);
      return counts[0] >= 2 && counts.every((count) => count === counts[0]);
    });
  // Do not feed arbitrary text/ZIP files to SheetJS. It accepts many byte streams as a
  // one-column workbook, which used to misclassify TXT and DOCX attachments as spreadsheets.
  if (!labelled && !isOleWorkbook && !isXlsxZip && !looksLikeCsv) return null;
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
    `• To email people from it: call ${ATTACHED_SPREADSHEET_EMAIL_TOOL_NAME}. Copy the requested`,
    `  filter values into that tool; the server, not you, selects and validates the actual recipients.`,
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
  const worksheets = parsed.worksheets?.length
    ? parsed.worksheets
    : [{ sheetName: parsed.sheetName, rows: parsed.rows, rowCount: parsed.rowCount, truncated: parsed.truncated }];
  if (!worksheets.some((sheet) => sheet.rows.length)) return "(the spreadsheet is empty)";
  let remainingBudget = maxRows;
  const blocks: string[] = [];
  for (const worksheet of worksheets) {
    if (remainingBudget <= 0) break;
    const shownCount = Math.min(worksheet.rowCount, remainingBudget);
    const shown = worksheet.rows.slice(0, shownCount + 1);
    const lines = shown.map((row) => row.values.join(" | "));
    const remaining = worksheet.rowCount - shownCount;
    const footer = remaining > 0 ? `\n… (${remaining} more row${remaining === 1 ? "" : "s"} not shown)` : "";
    blocks.push(
      `Sheet "${worksheet.sheetName}" — ${worksheet.rowCount} data row${worksheet.rowCount === 1 ? "" : "s"}:\n` +
        `${lines.join("\n")}${footer}`,
    );
    remainingBudget -= shownCount;
  }
  const hiddenSheets = worksheets.length - blocks.length;
  if (hiddenSheets > 0) blocks.push(`… (${hiddenSheets} more worksheet${hiddenSheets === 1 ? "" : "s"} not shown)`);
  return blocks.join("\n\n");
}

export type SpreadsheetFilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "after"
  | "on_or_after"
  | "before"
  | "on_or_before"
  | "greater_than"
  | "at_least"
  | "less_than"
  | "at_most"
  | "is_empty"
  | "is_not_empty";

export interface SpreadsheetFilter {
  column?: string;
  operator: SpreadsheetFilterOperator;
  value?: string;
}

export type MaterializedSpreadsheetEmail =
  | { ok: true; args: Record<string, unknown>; matchedRows: number }
  | { ok: false; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function validUtcDay(year: number, month: number, day: number): number | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const value = Date.UTC(year, month - 1, day);
  const date = new Date(value);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? value
    : null;
}

/**
 * Parse a calendar date without relying on JavaScript's locale-dependent Date string parser.
 * Ambiguous numeric dates (both first fields <= 12) are rejected instead of guessed.
 */
export function parseCalendarDay(value: string): number | null {
  const input = value.trim().replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  if (!input) return null;

  // Excel serial dates can still appear in CSV exports or loosely formatted workbooks.
  if (/^\d{4,5}(?:\.\d+)?$/.test(input)) {
    const decoded = XLSX.SSF.parse_date_code(Number(input));
    if (decoded) return validUtcDay(decoded.y, decoded.m, decoded.d);
  }

  let match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (match) return validUtcDay(Number(match[1]), Number(match[2]), Number(match[3]));

  match = input.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})(?:\s.*)?$/);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    if (first <= 12 && second <= 12) return null;
    return first > 12
      ? validUtcDay(year, second, first)
      : validUtcDay(year, first, second);
  }

  match = input.match(
    /^(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec),?\s+(\d{4})(?:\s.*)?$/i,
  );
  if (match) return validUtcDay(Number(match[3]), MONTHS[match[2].toLowerCase()], Number(match[1]));

  match = input.match(
    /^(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),?\s+(\d{4})(?:\s.*)?$/i,
  );
  if (match) return validUtcDay(Number(match[3]), MONTHS[match[1].toLowerCase()], Number(match[2]));

  return null;
}

const DATE_TOKEN =
  String.raw`(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?),?\s+\d{4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})`;

/** Extract explicit date comparisons from the user's own wording, preserving strict "after/before". */
export function inferDateFiltersFromMessage(message: string): SpreadsheetFilter[] {
  const filters: SpreadsheetFilter[] = [];
  const between = new RegExp(`\\bbetween\\s+(${DATE_TOKEN})\\s+and\\s+(${DATE_TOKEN})`, "i").exec(message);
  if (between) {
    return [
      { operator: "on_or_after", value: between[1] },
      { operator: "on_or_before", value: between[2] },
    ];
  }

  const comparison = new RegExp(
    `\\b(on\\s+or\\s+after|later\\s+than|after|since|from|on\\s+or\\s+before|earlier\\s+than|before|until|through)\\s+(${DATE_TOKEN})`,
    "gi",
  );
  for (const match of message.matchAll(comparison)) {
    const phrase = match[1].toLowerCase().replace(/\s+/g, " ");
    const operator: SpreadsheetFilterOperator =
      phrase === "after" || phrase === "later than"
        ? "after"
        : phrase === "before" || phrase === "earlier than"
          ? "before"
          : phrase === "on or before" || phrase === "until" || phrase === "through"
            ? "on_or_before"
            : "on_or_after";
    filters.push({ operator, value: match[2] });
  }
  return filters;
}

function normalizeOperator(value: unknown): SpreadsheetFilterOperator | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, SpreadsheetFilterOperator> = {
    "=": "equals",
    eq: "equals",
    "!=": "not_equals",
    gt: "greater_than",
    gte: "at_least",
    lt: "less_than",
    lte: "at_most",
  };
  const candidate = aliases[normalized] ?? normalized;
  const allowed: SpreadsheetFilterOperator[] = [
    "equals", "not_equals", "contains", "starts_with", "ends_with",
    "after", "on_or_after", "before", "on_or_before",
    "greater_than", "at_least", "less_than", "at_most", "is_empty", "is_not_empty",
  ];
  return allowed.includes(candidate as SpreadsheetFilterOperator)
    ? (candidate as SpreadsheetFilterOperator)
    : null;
}

function findColumn(headers: string[], hint: string | undefined, fallbacks: string[]): number {
  const normalized = headers.map((header) => header.trim().toLowerCase());
  if (hint?.trim()) {
    const wanted = hint.trim().toLowerCase();
    const exact = normalized.indexOf(wanted);
    if (exact >= 0) return exact;
    const partial = normalized.findIndex((header) => header.includes(wanted) || wanted.includes(header));
    if (partial >= 0) return partial;
    if (/^[a-z]+$/i.test(hint.trim())) {
      let index = 0;
      for (const char of hint.trim().toUpperCase()) index = index * 26 + char.charCodeAt(0) - 64;
      if (index > 0) return index - 1;
    }
  }
  for (const fallback of fallbacks) {
    const index = normalized.findIndex((header) => header.includes(fallback));
    if (index >= 0) return index;
  }
  return -1;
}

function matchesFilter(cell: string, filter: SpreadsheetFilter): boolean | null {
  const operator = filter.operator;
  const left = cell.trim();
  const right = String(filter.value ?? "").trim();
  if (operator === "is_empty") return left === "";
  if (operator === "is_not_empty") return left !== "";
  if (!right) return null;

  if (["after", "on_or_after", "before", "on_or_before"].includes(operator)) {
    const leftDay = parseCalendarDay(left);
    const rightDay = parseCalendarDay(right);
    if (leftDay == null || rightDay == null) return null;
    if (operator === "after") return leftDay > rightDay;
    if (operator === "on_or_after") return leftDay >= rightDay;
    if (operator === "before") return leftDay < rightDay;
    return leftDay <= rightDay;
  }

  if (["greater_than", "at_least", "less_than", "at_most"].includes(operator)) {
    const leftNumber = Number(left.replace(/[$,%\s,]/g, ""));
    const rightNumber = Number(right.replace(/[$,%\s,]/g, ""));
    if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return null;
    if (operator === "greater_than") return leftNumber > rightNumber;
    if (operator === "at_least") return leftNumber >= rightNumber;
    if (operator === "less_than") return leftNumber < rightNumber;
    return leftNumber <= rightNumber;
  }

  const a = left.toLocaleLowerCase();
  const b = right.toLocaleLowerCase();
  if (operator === "equals") return a === b;
  if (operator === "not_equals") return a !== b;
  if (operator === "contains") return a.includes(b);
  if (operator === "starts_with") return a.startsWith(b);
  return a.endsWith(b);
}

/**
 * Turn the model's intent-only attachment action into a normal send_bulk_email action.
 * Every recipient is selected from parsed rows here; model-provided addresses are never trusted.
 */
export function materializeSpreadsheetEmail(
  parsed: ParsedSpreadsheet,
  message: string,
  args: Record<string, unknown>,
  fileName?: string | null,
): MaterializedSpreadsheetEmail {
  const subject = String(args.subject ?? "").trim();
  const body = String(args.body ?? args.bodyTemplate ?? "").trim();
  if (!subject || !body) return { ok: false, message: "I need both the email subject and body before I can prepare this workflow." };
  const worksheets = parsed.worksheets?.length
    ? parsed.worksheets
    : [{ sheetName: parsed.sheetName, rows: parsed.rows, rowCount: parsed.rowCount, truncated: parsed.truncated }];
  const requestedSheet = String(args.sheetName ?? "").trim().toLowerCase();
  const emailHint = args.emailColumn ? String(args.emailColumn) : undefined;
  const worksheet =
    (requestedSheet
      ? worksheets.find((candidate) => candidate.sheetName.trim().toLowerCase() === requestedSheet) ??
        worksheets.find((candidate) => candidate.sheetName.trim().toLowerCase().includes(requestedSheet))
      : undefined) ??
    worksheets.find(
      (candidate) =>
        candidate.rows.length >= 2 &&
        findColumn(candidate.rows[0].values, emailHint, ["email address", "e-mail", "email", "mail"]) >= 0,
    ) ??
    worksheets[0];
  if (!worksheet || worksheet.rows.length < 2) {
    return { ok: false, message: "The attached spreadsheet has no data rows to email." };
  }
  if (worksheet.truncated) {
    return {
      ok: false,
      message:
        `The "${worksheet.sheetName}" worksheet is larger than the ${MAX_ROWS}-row analysis limit. ` +
        "Narrow or split the file before sending so no recipient is silently missed.",
    };
  }

  const headers = worksheet.rows[0].values;
  const emailIndex = findColumn(
    headers,
    emailHint,
    ["email address", "e-mail", "email", "mail"],
  );
  if (emailIndex < 0) {
    return { ok: false, message: "I couldn't find an email column in the attached spreadsheet. Name that column and try again." };
  }
  const nameIndex = findColumn(
    headers,
    args.nameColumn ? String(args.nameColumn) : undefined,
    ["full name", "recipient name", "employee", "name"],
  );

  const suppliedFilters: SpreadsheetFilter[] = [];
  if (Array.isArray(args.filters)) {
    for (const item of args.filters) {
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      const operator = normalizeOperator(raw.operator);
      if (!operator) continue;
      suppliedFilters.push({
        column: raw.column ? String(raw.column) : undefined,
        operator,
        value: raw.value == null ? undefined : String(raw.value),
      });
    }
  }
  // Backward compatibility for a model that emitted the old Drive-sheet date fields.
  if (args.fromDate) {
    suppliedFilters.push({
      column: args.dateColumn ? String(args.dateColumn) : undefined,
      operator: "on_or_after",
      value: String(args.fromDate),
    });
  }
  if (args.toDate) {
    suppliedFilters.push({
      column: args.dateColumn ? String(args.dateColumn) : undefined,
      operator: "on_or_before",
      value: String(args.toDate),
    });
  }

  // The user's literal wording wins over model normalization. This is what makes
  // "after 19th July 2026" and "after 7/19/2026" produce the same strict result.
  const inferredDates = inferDateFiltersFromMessage(message);
  const modelDateColumn =
    suppliedFilters.find((filter) => ["after", "on_or_after", "before", "on_or_before"].includes(filter.operator))?.column ??
    (args.dateColumn ? String(args.dateColumn) : undefined);
  const nonDateFilters = suppliedFilters.filter(
    (filter) => !["after", "on_or_after", "before", "on_or_before"].includes(filter.operator),
  );
  const filters = inferredDates.length
    ? [...nonDateFilters, ...inferredDates.map((filter) => ({ ...filter, column: modelDateColumn }))]
    : suppliedFilters;

  const resolvedFilters: { filter: SpreadsheetFilter; columnIndex: number; header: string }[] = [];
  for (const filter of filters) {
    const isDate = ["after", "on_or_after", "before", "on_or_before"].includes(filter.operator);
    const columnIndex = findColumn(
      headers,
      filter.column,
      isDate ? ["timestamp", "date", "created", "joined", "join", "start", "hired"] : [],
    );
    if (columnIndex < 0 || columnIndex >= headers.length) {
      return {
        ok: false,
        message: `I couldn't find the ${filter.column ? `"${filter.column}"` : "requested filter"} column in the attached spreadsheet.`,
      };
    }
    if (isDate && parseCalendarDay(String(filter.value ?? "")) == null) {
      return {
        ok: false,
        message: `The date "${filter.value ?? ""}" is invalid or ambiguous. Use an unambiguous date such as 2026-07-19.`,
      };
    }
    resolvedFilters.push({ filter, columnIndex, header: headers[columnIndex] });
  }

  const recipients: { email: string; name: string }[] = [];
  const seen = new Set<string>();
  let invalidFilterValues = 0;
  let invalidEmailRows = 0;
  let duplicateEmailRows = 0;
  for (const row of worksheet.rows.slice(1)) {
    let include = true;
    for (const resolved of resolvedFilters) {
      const result = matchesFilter(row.values[resolved.columnIndex] ?? "", resolved.filter);
      if (result == null) invalidFilterValues++;
      if (result !== true) {
        include = false;
        break;
      }
    }
    if (!include) continue;
    const email = (row.values[emailIndex] ?? "").trim();
    const key = email.toLowerCase();
    if (!EMAIL_RE.test(email)) {
      invalidEmailRows++;
      continue;
    }
    if (seen.has(key)) {
      duplicateEmailRows++;
      continue;
    }
    seen.add(key);
    recipients.push({ email, name: nameIndex >= 0 ? (row.values[nameIndex] ?? "").trim() : "" });
  }

  if (invalidFilterValues > 0) {
    return {
      ok: false,
      message:
        `I couldn't safely apply the filter to ${invalidFilterValues} row value(s) because they are invalid or ambiguous. ` +
        "Normalize that column (dates should use YYYY-MM-DD) and attach the file again.",
    };
  }
  if (recipients.length === 0) {
    const filterNote = resolvedFilters.length
      ? ` matching ${resolvedFilters.map(({ header, filter }) => `${header} ${filter.operator} "${filter.value ?? ""}"`).join(" and ")}`
      : "";
    const invalidNote = invalidFilterValues ? " Some rows contained invalid or ambiguous filter values." : "";
    return { ok: false, message: `No valid email recipients were found${filterNote}.${invalidNote}` };
  }
  if (recipients.length > MAX_BULK_EMAIL_RECIPIENTS) {
    return {
      ok: false,
      message: `The attachment matches ${recipients.length} recipients, above the ${MAX_BULK_EMAIL_RECIPIENTS}-email safety limit. Narrow the filter and try again.`,
    };
  }

  return {
    ok: true,
    matchedRows: recipients.length,
    args: {
      recipients,
      subject,
      body,
      attachmentSelection: {
        fileName: fileName ?? "attached spreadsheet",
        sheetName: worksheet.sheetName,
        matchedRows: recipients.length,
        invalidEmailRows,
        duplicateEmailRows,
        filters: resolvedFilters.map(({ header, filter }) => ({
          column: header,
          operator: filter.operator,
          value: filter.value ?? "",
        })),
      },
    },
  };
}
