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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal inline Markdown → HTML (bold, italic, code, links). */
function inlineMarkdown(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>")
    .replace(/\[(.+?)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * Block-level Markdown → HTML. Drive converts uploaded HTML into a formatted Google Doc, so
 * this is what turns an agent-authored report (headings, bullet/numbered lists, paragraphs)
 * into a real document instead of a wall of text.
 */
function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeLists(); continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.+)$/))) {
      closeLists();
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inlineMarkdown(m[2])}</h${lvl}>`);
    } else if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) {
      const text = line.replace(/^\s*[-*]\s+\[([ xX])\]\s+/, (_s, c) => (c.toLowerCase() === "x" ? "☑ " : "☐ "));
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inlineMarkdown(text)}</li>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.+)$/))) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inlineMarkdown(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.+)$/))) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${inlineMarkdown(m[1])}</li>`);
    } else {
      closeLists();
      out.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  closeLists();
  return `<!DOCTYPE html><html><body>${out.join("")}</body></html>`;
}

/**
 * Create a new Google Doc and return its link. When `content` is given (Markdown), it's
 * converted to HTML and uploaded so Drive produces a fully-formatted document — the vehicle
 * for agent-generated reports the user can then download (PDF/Word) or share.
 */
export async function createDriveDoc(userId: string, name: string, content?: string): Promise<DriveFile> {
  const drive = await getDriveClient(userId);
  const body = content?.trim();
  const res = await drive.files.create({
    requestBody: { name: name || "Untitled document", mimeType: "application/vnd.google-apps.document" },
    ...(body
      ? { media: { mimeType: "text/html", body: Readable.from(Buffer.from(markdownToHtml(body), "utf8")) } }
      : {}),
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
