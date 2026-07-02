/**
 * Notion API service (OAuth, free tier).
 * Tokens stored in connected_integrations table.
 * Notion tokens do not expire.
 */

import { getIntegration, upsertIntegration } from "../integrations/tokenStore";
import { BadRequestError } from "../../utils/errors";

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_OAUTH = "https://api.notion.com/v1/oauth";
const NOTION_VERSION = "2022-06-28";

function clientId(): string {
  const id = process.env.NOTION_CLIENT_ID;
  if (!id) throw new Error("NOTION_CLIENT_ID is not configured.");
  return id;
}
function clientSecret(): string {
  const s = process.env.NOTION_CLIENT_SECRET;
  if (!s) throw new Error("NOTION_CLIENT_SECRET is not configured.");
  return s;
}
function redirectUri(): string {
  // Backend-mediated OAuth: Notion rejects custom-scheme redirect URIs and
  // requires https. Notion redirects to our https callback, which exchanges the
  // code and then deep-links into the app. Override with NOTION_REDIRECT_URI.
  return (
    process.env.NOTION_REDIRECT_URI ??
    `${process.env.API_BASE_URL ?? "http://localhost:5000"}/api/v1/notion/callback`
  );
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    owner: "user",
    redirect_uri: redirectUri(),
    state,
  });
  return `https://api.notion.com/v1/oauth/authorize?${params}`;
}

export async function exchangeCode(userId: string, code: string): Promise<void> {
  const credentials = Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");
  const res = await fetch(`${NOTION_OAUTH}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri() }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Notion token exchange failed: ${t.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    workspace_id: string;
    workspace_name: string;
    workspace_icon: string | null;
  };

  await upsertIntegration(userId, "notion", {
    accessToken: data.access_token,
    scopes: ["read_content", "update_content", "insert_content"],
  }, {
    workspaceId: data.workspace_id,
    workspaceName: data.workspace_name,
  });
}

// ─── Authed fetch ────────────────────────────────────────────────────────────

async function notionFetch(userId: string, path: string, opts: RequestInit = {}): Promise<Response> {
  const integration = await getIntegration(userId, "notion");
  if (!integration || integration.status === "revoked") {
    throw new BadRequestError("Notion is not connected. Connect it from Settings → Connected Accounts.");
  }
  return fetch(`${NOTION_BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      Authorization: `Bearer ${integration.accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });
}

// ─── Pages ───────────────────────────────────────────────────────────────────

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  lastEdited: string;
}

export async function searchPages(userId: string, query: string): Promise<NotionPage[]> {
  const res = await notionFetch(userId, "/search", {
    method: "POST",
    body: JSON.stringify({ query, filter: { value: "page", property: "object" }, page_size: 20 }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    results?: {
      id?: string;
      url?: string;
      last_edited_time?: string;
      properties?: { title?: { title?: { plain_text?: string }[] } };
    }[];
  };

  return (data.results ?? []).map((p) => ({
    id: p.id ?? "",
    title: p.properties?.title?.title?.[0]?.plain_text ?? "Untitled",
    url: p.url ?? "",
    lastEdited: p.last_edited_time ?? "",
  }));
}

export async function createPage(
  userId: string,
  data: { parentId: string; title: string; content?: string },
): Promise<NotionPage> {
  const children = data.content
    ? [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: data.content } }] } }]
    : [];

  const res = await notionFetch(userId, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: data.parentId },
      properties: {
        title: { title: [{ text: { content: data.title } }] },
      },
      children,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Failed to create Notion page: ${t.slice(0, 200)}`);
  }
  const p = (await res.json()) as { id?: string; url?: string; last_edited_time?: string };
  return { id: p.id ?? "", title: data.title, url: p.url ?? "", lastEdited: p.last_edited_time ?? "" };
}

// ─── Databases ───────────────────────────────────────────────────────────────

export interface NotionDatabase {
  id: string;
  title: string;
  url: string;
}

export async function getDatabases(userId: string): Promise<NotionDatabase[]> {
  const res = await notionFetch(userId, "/search", {
    method: "POST",
    body: JSON.stringify({ filter: { value: "database", property: "object" }, page_size: 20 }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    results?: { id?: string; url?: string; title?: { plain_text?: string }[] }[];
  };
  return (data.results ?? []).map((db) => ({
    id: db.id ?? "",
    title: db.title?.[0]?.plain_text ?? "Untitled Database",
    url: db.url ?? "",
  }));
}

export async function queryDatabase(
  userId: string,
  databaseId: string,
  filter?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const res = await notionFetch(userId, `/databases/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ filter, page_size: 50 }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: Record<string, unknown>[] };
  return data.results ?? [];
}
