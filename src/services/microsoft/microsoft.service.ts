/**
 * Microsoft Graph service (Personal Mode). ONE Azure AD OAuth app unlocks four
 * surfaces: Outlook Mail, Outlook Calendar, Microsoft Teams, and OneDrive.
 * Tokens (with a refresh token via the offline_access scope) are stored in
 * connected_integrations under provider "microsoft". See doc/microsoft-setup.md.
 */

import { getIntegration, updateAccessToken, upsertIntegration } from "../integrations/tokenStore";
import { BadRequestError } from "../../utils/errors";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function tenant(): string {
  return process.env.MICROSOFT_TENANT?.trim() || "common";
}
function authBase(): string {
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0`;
}
function clientId(): string {
  const id = process.env.MICROSOFT_CLIENT_ID;
  if (!id) throw new Error("MICROSOFT_CLIENT_ID is not configured.");
  return id;
}
function clientSecret(): string {
  const s = process.env.MICROSOFT_CLIENT_SECRET;
  if (!s) throw new Error("MICROSOFT_CLIENT_SECRET is not configured.");
  return s;
}
function redirectUri(): string {
  return (
    process.env.MICROSOFT_REDIRECT_URI ??
    `${process.env.API_BASE_URL ?? "http://localhost:5000"}/api/v1/microsoft/callback`
  );
}

// Delegated scopes — one consent covers mail, calendar, Teams chat, and OneDrive.
const SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Chat.ReadWrite",
  "ChannelMessage.Send",
  "Files.ReadWrite",
];

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirectUri(),
    response_mode: "query",
    scope: SCOPES.join(" "),
    state,
  });
  return `${authBase()}/authorize?${params}`;
}

export async function exchangeCode(userId: string, code: string): Promise<void> {
  const res = await fetch(`${authBase()}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Microsoft token exchange failed: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  await upsertIntegration(userId, "microsoft", {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: (data.scope ?? SCOPES.join(" ")).split(" "),
  });
}

async function refreshAccessToken(userId: string, refreshToken: string): Promise<string> {
  const res = await fetch(`${authBase()}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) throw new Error("Microsoft token refresh failed");
  const data = (await res.json()) as { access_token: string; expires_in: number };
  await updateAccessToken(userId, "microsoft", data.access_token, new Date(Date.now() + data.expires_in * 1000));
  return data.access_token;
}

// ─── Authed Graph fetch (auto-refresh on 401) ─────────────────────────────────

async function graphFetch(userId: string, path: string, opts: RequestInit = {}): Promise<Response> {
  const integration = await getIntegration(userId, "microsoft");
  if (!integration || integration.status === "revoked") {
    throw new BadRequestError("Microsoft is not connected. Connect it from Settings → Connected Accounts.");
  }
  let token = integration.accessToken;
  const doFetch = (t: string) =>
    fetch(`${GRAPH_BASE}${path}`, {
      ...opts,
      headers: { ...(opts.headers ?? {}), Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    });

  let res = await doFetch(token);
  if (res.status === 401 && integration.refreshToken) {
    token = await refreshAccessToken(userId, integration.refreshToken);
    res = await doFetch(token);
  }
  return res;
}

async function graphErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

async function ensureOk(res: Response, action: string): Promise<void> {
  if (res.ok || res.status === 202 || res.status === 204) return;
  throw new BadRequestError(`${action} failed on Microsoft: ${await graphErrorDetail(res)}`);
}

// ─── Outlook Mail ─────────────────────────────────────────────────────────────

export interface OutlookMessage {
  id: string;
  subject: string;
  from: string;
  received: string;
  preview: string;
}

export async function listOutlookMessages(userId: string, limit = 10): Promise<OutlookMessage[]> {
  const res = await graphFetch(
    userId,
    `/me/mailFolders/inbox/messages?$top=${Math.min(limit, 25)}&$select=subject,from,receivedDateTime,bodyPreview&$orderby=receivedDateTime desc`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    value?: { id?: string; subject?: string; from?: { emailAddress?: { address?: string; name?: string } }; receivedDateTime?: string; bodyPreview?: string }[];
  };
  return (data.value ?? [])
    .filter((m) => m.id)
    .map((m) => ({
      id: m.id!,
      subject: m.subject ?? "(no subject)",
      from: m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? "unknown sender",
      received: m.receivedDateTime ?? "",
      preview: m.bodyPreview ?? "",
    }));
}

export async function sendOutlookMail(
  userId: string,
  data: { to: string; subject: string; body: string },
): Promise<void> {
  const res = await graphFetch(userId, "/me/sendMail", {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: data.subject,
        body: { contentType: "Text", content: data.body },
        toRecipients: [{ emailAddress: { address: data.to } }],
      },
      saveToSentItems: true,
    }),
  });
  await ensureOk(res, "Send Outlook mail");
}

// ─── Outlook Calendar ─────────────────────────────────────────────────────────

export interface OutlookEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  webLink: string;
}

export async function listOutlookEvents(userId: string, limit = 10): Promise<OutlookEvent[]> {
  const res = await graphFetch(
    userId,
    `/me/events?$top=${Math.min(limit, 25)}&$select=subject,start,end,webLink&$orderby=start/dateTime desc`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    value?: { id?: string; subject?: string; start?: { dateTime?: string }; end?: { dateTime?: string }; webLink?: string }[];
  };
  return (data.value ?? [])
    .filter((e) => e.id)
    .map((e) => ({
      id: e.id!,
      subject: e.subject ?? "(no title)",
      start: e.start?.dateTime ?? "",
      end: e.end?.dateTime ?? "",
      webLink: e.webLink ?? "",
    }));
}

export async function createOutlookEvent(
  userId: string,
  data: { subject: string; startTime: string; endTime: string; attendees?: string[]; body?: string },
): Promise<OutlookEvent> {
  const res = await graphFetch(userId, "/me/events", {
    method: "POST",
    body: JSON.stringify({
      subject: data.subject,
      body: data.body ? { contentType: "Text", content: data.body } : undefined,
      start: { dateTime: data.startTime, timeZone: "UTC" },
      end: { dateTime: data.endTime, timeZone: "UTC" },
      attendees: (data.attendees ?? []).map((address) => ({ emailAddress: { address }, type: "required" })),
    }),
  });
  await ensureOk(res, "Create Outlook event");
  const e = (await res.json()) as { id?: string; subject?: string; start?: { dateTime?: string }; end?: { dateTime?: string }; webLink?: string };
  return { id: e.id ?? "", subject: e.subject ?? data.subject, start: e.start?.dateTime ?? data.startTime, end: e.end?.dateTime ?? data.endTime, webLink: e.webLink ?? "" };
}

// ─── Microsoft Teams ──────────────────────────────────────────────────────────

export interface TeamsChat {
  id: string;
  topic: string;
  type: string;
}

export async function listTeamsChats(userId: string, limit = 20): Promise<TeamsChat[]> {
  const res = await graphFetch(userId, `/me/chats?$top=${Math.min(limit, 50)}&$select=id,topic,chatType`);
  if (!res.ok) return [];
  const data = (await res.json()) as { value?: { id?: string; topic?: string | null; chatType?: string }[] };
  return (data.value ?? [])
    .filter((c) => c.id)
    .map((c) => ({ id: c.id!, topic: c.topic ?? "(untitled chat)", type: c.chatType ?? "chat" }));
}

export async function sendTeamsMessage(userId: string, chatId: string, text: string): Promise<void> {
  const res = await graphFetch(userId, `/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: { content: text } }),
  });
  await ensureOk(res, "Send Teams message");
}

// ─── OneDrive ─────────────────────────────────────────────────────────────────

export interface OneDriveFile {
  id: string;
  name: string;
  webUrl: string;
  isFolder: boolean;
}

function mapDriveItems(items: { id?: string; name?: string; webUrl?: string; folder?: unknown }[]): OneDriveFile[] {
  return items
    .filter((i) => i.id)
    .map((i) => ({ id: i.id!, name: i.name ?? "Untitled", webUrl: i.webUrl ?? "", isFolder: i.folder != null }));
}

export async function listOneDriveFiles(userId: string, query?: string): Promise<OneDriveFile[]> {
  const path = query?.trim()
    ? `/me/drive/root/search(q='${encodeURIComponent(query.trim())}')?$top=20&$select=id,name,webUrl,folder`
    : `/me/drive/root/children?$top=20&$select=id,name,webUrl,folder`;
  const res = await graphFetch(userId, path);
  if (!res.ok) return [];
  const data = (await res.json()) as { value?: { id?: string; name?: string; webUrl?: string; folder?: unknown }[] };
  return mapDriveItems(data.value ?? []);
}

export async function shareOneDriveFile(userId: string, itemId: string): Promise<string> {
  const res = await graphFetch(userId, `/me/drive/items/${encodeURIComponent(itemId)}/createLink`, {
    method: "POST",
    body: JSON.stringify({ type: "view", scope: "organization" }),
  });
  await ensureOk(res, "Create OneDrive share link");
  const data = (await res.json()) as { link?: { webUrl?: string } };
  return data.link?.webUrl ?? "";
}
