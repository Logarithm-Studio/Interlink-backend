import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx";
import { prepareAssistantAttachment } from "../ai/attachment.service";
import {
  inferDateFiltersFromMessage,
  materializeSpreadsheetEmail,
  parseCalendarDay,
  parseSpreadsheet,
  requestsSpreadsheetRecipientEmail,
  tryParseSpreadsheetAttachment,
  type ParsedSpreadsheet,
} from "./spreadsheet.service";

const sheet: ParsedSpreadsheet = {
  sheetName: "Interlink",
  rowCount: 3,
  truncated: false,
  rows: [
    { values: ["Name", "Email", "Timestamp"] },
    { values: ["On boundary", "boundary@example.com", "7/19/2026"] },
    { values: ["After one", "after1@example.com", "7/20/2026 10:30 AM"] },
    { values: ["After two", "after2@example.com", "21 July 2026"] },
  ],
};

const emailArgs = {
  subject: "Welcome",
  body: "Hello {{name}}",
  dateColumn: "Timestamp",
  // Deliberately wrong/inclusive model output. Literal user wording must override it.
  filters: [{ column: "Timestamp", operator: "on_or_after", value: "2026-07-19" }],
  // Deliberately hallucinated. The deterministic materializer must ignore it.
  recipients: [{ email: "invented@example.com", name: "Invented" }],
};

test("calendar dates normalize without locale-dependent Date parsing", () => {
  const expected = Date.UTC(2026, 6, 19);
  assert.equal(parseCalendarDay("2026-07-19"), expected);
  assert.equal(parseCalendarDay("19th July 2026"), expected);
  assert.equal(parseCalendarDay("July 19, 2026"), expected);
  assert.equal(parseCalendarDay("7/19/2026"), expected);
  assert.equal(parseCalendarDay("19/7/2026"), expected);
  assert.equal(parseCalendarDay("7/8/2026"), null);
});

test("literal after wording stays exclusive for every supported date spelling", () => {
  for (const message of [
    "Find people with timestamp after 19th July 2026 and email them.",
    "Find people with timestamp after 7/19/2026 and email them.",
    "Find people with timestamp after 2026-07-19 and email them.",
  ]) {
    assert.equal(inferDateFiltersFromMessage(message)[0]?.operator, "after");
    const result = materializeSpreadsheetEmail(sheet, message, emailArgs, "Interlink.xlsx");
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.deepEqual(
      (result.args.recipients as { email: string }[]).map((recipient) => recipient.email),
      ["after1@example.com", "after2@example.com"],
    );
    assert.equal(result.matchedRows, 2);
  }
});

test("recipient-from-sheet requests are distinguished from emailing the user a summary", () => {
  assert.equal(
    requestsSpreadsheetRecipientEmail(
      "Find people who have timestamp after 19th July 2026 and send them the above email.",
    ),
    true,
  );
  assert.equal(requestsSpreadsheetRecipientEmail("Analyze the people in this sheet and email me a summary."), false);
});

test("ambiguous dates fail closed instead of selecting guessed recipients", () => {
  const result = materializeSpreadsheetEmail(
    sheet,
    "Email people after 7/8/2026.",
    { ...emailArgs, filters: [{ column: "Timestamp", operator: "after", value: "7/8/2026" }] },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /ambiguous/i);
});

test("invalid spreadsheet date values block a partial send instead of being silently skipped", () => {
  const result = materializeSpreadsheetEmail(
    {
      ...sheet,
      rowCount: 4,
      rows: [...sheet.rows, { values: ["Bad date", "bad@example.com", "not a date"] }],
    },
    "Email people after 2026-07-19.",
    emailArgs,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /couldn't safely apply/i);
});

test("xlsx date cells are rendered as readable dates rather than serial numbers", () => {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["Name", "Email", "Timestamp"],
    ["Taylor", "taylor@example.com", new Date(Date.UTC(2026, 6, 20))],
  ]);
  XLSX.utils.book_append_sheet(workbook, worksheet, "People");
  const base64 = XLSX.write(workbook, { type: "base64", bookType: "xlsx" });
  const parsed = parseSpreadsheet(base64, "people.xlsx");
  assert.match(parsed.rows[1].values[2], /2026|7\/20|20\/7/);
  assert.doesNotMatch(parsed.rows[1].values[2], /^46\d{3}$/);
});

test("email selection finds the data worksheet when the first tab is only instructions", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Read me"], ["Use the People tab"]]), "Instructions");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Name", "Email", "Timestamp"],
      ["Taylor", "taylor@example.com", "2026-07-20"],
    ]),
    "People",
  );
  const parsed = parseSpreadsheet(XLSX.write(workbook, { type: "base64", bookType: "xlsx" }), "people.xlsx");
  const result = materializeSpreadsheetEmail(
    parsed,
    "Email everyone after 2026-07-19.",
    { subject: "Welcome", body: "Hello {{name}}", dateColumn: "Timestamp" },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal((result.args.attachmentSelection as { sheetName: string }).sheetName, "People");
    assert.deepEqual(result.args.recipients, [{ email: "taylor@example.com", name: "Taylor" }]);
  }
});

test("plain text is not misclassified as a spreadsheet and is exposed to the assistant", () => {
  const base64 = Buffer.from("First line\nSecond line", "utf8").toString("base64");
  assert.equal(tryParseSpreadsheetAttachment(base64, "text/plain", "notes.txt"), null);
  const prepared = prepareAssistantAttachment({ data: base64, mimeType: "text/plain", name: "notes.txt" });
  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.equal(prepared.value.kind, "text");
    assert.match(JSON.stringify(prepared.value.parts), /First line/);
  }
});

test("DOCX content is extracted locally instead of sending an unsupported MIME payload", () => {
  const archive = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      "<w:document><w:body><w:p><w:r><w:t>Quarterly plan</w:t></w:r></w:p></w:body></w:document>",
    ),
  });
  const prepared = prepareAssistantAttachment({
    data: Buffer.from(archive).toString("base64"),
    mimeType: "application/octet-stream",
    name: "plan.docx",
  });
  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.equal(prepared.value.kind, "document");
    assert.match(JSON.stringify(prepared.value.parts), /Quarterly plan/);
    assert.doesNotMatch(JSON.stringify(prepared.value.parts), /inlineData/);
  }
});
