/**
 * Google Drive service (Personal Mode). Reuses the shared Google OAuth token.
 * Requires the Drive scope (see GOOGLE_SCOPES in routes/auth.routes.ts). Users who
 * connected Google before the scope was added must reconnect to grant it.
 */

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
