/**
 * Google Sheets API service for HR.
 * Reuses existing Google OAuth tokens. Requires 'https://www.googleapis.com/auth/spreadsheets' scope.
 */

import { google } from "googleapis";
import { refreshGoogleTokenIfNeeded } from "../auth.service";

async function getSheetsClient(userId: string) {
  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.sheets({ version: "v4", auth });
}

export interface SheetRow {
  rowIndex: number;
  values: string[];
}

export async function readSheetRange(
  userId: string,
  spreadsheetId: string,
  range: string,
): Promise<SheetRow[]> {
  const sheets = await getSheetsClient(userId);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values ?? [];
  return rows.map((row, i) => ({ rowIndex: i, values: row.map(String) }));
}

export async function appendSheetRow(
  userId: string,
  spreadsheetId: string,
  range: string,
  values: string[],
): Promise<void> {
  const sheets = await getSheetsClient(userId);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

export async function updateSheetRow(
  userId: string,
  spreadsheetId: string,
  range: string,
  values: string[],
): Promise<void> {
  const sheets = await getSheetsClient(userId);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

export async function listSpreadsheets(userId: string): Promise<{ id: string; name: string }[]> {
  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: "v3", auth });

  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: "files(id,name)",
    pageSize: 30,
  });

  return (res.data.files ?? []).map((f) => ({ id: f.id!, name: f.name ?? "Untitled" }));
}
