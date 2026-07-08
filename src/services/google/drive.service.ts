/**
 * Google Drive service (Personal Mode). Reuses the shared Google OAuth token.
 * Requires the Drive scope (see GOOGLE_SCOPES in routes/auth.routes.ts). Users who
 * connected Google before the scope was added must reconnect to grant it.
 */

import { Readable } from "stream";
import { google } from "googleapis";
import { refreshGoogleTokenIfNeeded } from "../auth.service";

async function getDriveClient(userId: string) {
  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth });
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  modifiedTime: string;
}

function mapFiles(
  files: { id?: string | null; name?: string | null; mimeType?: string | null; webViewLink?: string | null; modifiedTime?: string | null }[],
): DriveFile[] {
  return files
    .filter((f) => f.id)
    .map((f) => ({
      id: f.id!,
      name: f.name ?? "Untitled",
      mimeType: f.mimeType ?? "",
      webViewLink: f.webViewLink ?? "",
      modifiedTime: f.modifiedTime ?? "",
    }));
}

/** List recent files, or search by name when `query` is provided. */
export async function listDriveFiles(userId: string, query?: string): Promise<DriveFile[]> {
  const drive = await getDriveClient(userId);
  const q = query?.trim()
    ? `name contains '${query.trim().replace(/'/g, "\\'")}' and trashed = false`
    : "trashed = false";
  const res = await drive.files.list({
    q,
    pageSize: 20,
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,webViewLink,modifiedTime)",
  });
  return mapFiles(res.data.files ?? []);
}

/** Find a single file by (partial) name — used to resolve an id from a spoken name. */
export async function findDriveFile(userId: string, name: string): Promise<DriveFile | null> {
  const files = await listDriveFiles(userId, name);
  return files[0] ?? null;
}

/** Upload raw file bytes (from a base64 payload) to the user's Drive. */
export async function uploadDriveFile(
  userId: string,
  file: { name: string; mimeType: string; base64: string },
): Promise<DriveFile> {
  const drive = await getDriveClient(userId);
  const buffer = Buffer.from(file.base64, "base64");
  const res = await drive.files.create({
    requestBody: { name: file.name || "Upload" },
    media: { mimeType: file.mimeType || "application/octet-stream", body: Readable.from(buffer) },
    fields: "id,name,mimeType,webViewLink,modifiedTime",
  });
  const f = res.data;
  return {
    id: f.id ?? "",
    name: f.name ?? file.name,
    mimeType: f.mimeType ?? file.mimeType,
    webViewLink: f.webViewLink ?? "",
    modifiedTime: f.modifiedTime ?? new Date().toISOString(),
  };
}

/** Move a file to trash. */
export async function deleteDriveFile(userId: string, fileId: string): Promise<void> {
  const drive = await getDriveClient(userId);
  await drive.files.update({ fileId, requestBody: { trashed: true } });
}

/** Make a file link-shareable (anyone with the link can view) and return its link. */
export async function shareDriveFile(userId: string, fileId: string): Promise<string> {
  const drive = await getDriveClient(userId);
  await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } });
  const res = await drive.files.get({ fileId, fields: "webViewLink" });
  return res.data.webViewLink ?? "";
}

/** Create a new Google Doc and return its link. */
export async function createDriveDoc(userId: string, name: string): Promise<DriveFile> {
  const drive = await getDriveClient(userId);
  const res = await drive.files.create({
    requestBody: { name: name || "Untitled document", mimeType: "application/vnd.google-apps.document" },
    fields: "id,name,mimeType,webViewLink,modifiedTime",
  });
  const f = res.data;
  return {
    id: f.id ?? "",
    name: f.name ?? name,
    mimeType: f.mimeType ?? "application/vnd.google-apps.document",
    webViewLink: f.webViewLink ?? "",
    modifiedTime: f.modifiedTime ?? new Date().toISOString(),
  };
}
