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
  // Render the body as real Notion blocks (headings/bullets/to-dos/code), not a single
  // paragraph — so created pages are structured documents, not text blobs.
  const children = data.content ? markdownToBlocks(data.content) : [];

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

/**
 * Append markdown content to an existing page as structured blocks (the way "add
 * this to my Notion page" and richer publishing work). Notion caps 100 blocks per
 * request, so we chunk.
 */
export async function appendToPage(userId: string, pageId: string, markdown: string): Promise<void> {
  const blocks = markdownToBlocks(markdown);
  if (blocks.length === 0) return;
  for (let i = 0; i < blocks.length; i += 100) {
    const res = await notionFetch(userId, `/blocks/${pageId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: blocks.slice(i, i + 100) }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Failed to append to Notion page: ${t.slice(0, 200)}`);
    }
  }
}

/**
 * Add a row to a Notion database. Resolves the database's title property name from
 * its schema, then creates a page under it. `extraProps` maps property name → a
 * simple rich-text/select value (best-effort; unknown props are skipped by Notion).
 */
export async function createDatabaseRow(
  userId: string,
  databaseId: string,
  title: string,
  content?: string,
): Promise<NotionPage> {
  // Find the title property's name (it varies: "Name", "Task", etc.).
  const schemaRes = await notionFetch(userId, `/databases/${databaseId}`, { method: "GET" });
  let titleProp = "Name";
  if (schemaRes.ok) {
    const schema = (await schemaRes.json()) as { properties?: Record<string, { type?: string }> };
    const found = Object.entries(schema.properties ?? {}).find(([, v]) => v.type === "title");
    if (found) titleProp = found[0];
  }

  const res = await notionFetch(userId, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "database_id", database_id: databaseId },
      properties: { [titleProp]: { title: [{ text: { content: title } }] } },
      children: content ? markdownToBlocks(content) : [],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Failed to add Notion database row: ${t.slice(0, 200)}`);
  }
  const p = (await res.json()) as { id?: string; url?: string; last_edited_time?: string };
  return { id: p.id ?? "", title, url: p.url ?? "", lastEdited: p.last_edited_time ?? "" };
}

// ─── Markdown → Notion blocks ──────────────────────────────────────────────────

type NotionBlock = { object: "block"; type: string; [k: string]: unknown };

const richText = (content: string) => [{ type: "text", text: { content: content.slice(0, 2000) } }];
const textBlock = (type: string, content: string, extra: Record<string, unknown> = {}): NotionBlock => ({
  object: "block",
  type,
  [type]: { rich_text: richText(content), ...extra },
});

/** Convert lightweight markdown into Notion blocks (headings, lists, to-dos, code, quotes). */
export function markdownToBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  let codeBuf: string[] = [];
  let codeLang = "";

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const fence = line.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      if (inFence) {
        blocks.push({ object: "block", type: "code", code: { rich_text: richText(codeBuf.join("\n")), language: (codeLang || "plain text") as string } });
        inFence = false;
        codeBuf = [];
        codeLang = "";
      } else {
        inFence = true;
        codeLang = fence[1] ?? "";
      }
      continue;
    }
    if (inFence) {
      codeBuf.push(raw);
      continue;
    }
    if (!line.trim()) continue; // Notion collapses empty paragraphs anyway

    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const level = Math.min(3, h[1].length);
      blocks.push(textBlock(`heading_${level}`, h[2]));
      continue;
    }
    const todo = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (todo) {
      blocks.push(textBlock("to_do", todo[2], { checked: todo[1].toLowerCase() === "x" }));
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      blocks.push(textBlock("bulleted_list_item", line.replace(/^\s*[-*•]\s+/, "")));
      continue;
    }
    const num = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (num) {
      blocks.push(textBlock("numbered_list_item", num[1]));
      continue;
    }
    if (/^\s*>\s+/.test(line)) {
      blocks.push(textBlock("quote", line.replace(/^\s*>\s+/, "")));
      continue;
    }
    blocks.push(textBlock("paragraph", line));
  }
  if (inFence && codeBuf.length) {
    blocks.push({ object: "block", type: "code", code: { rich_text: richText(codeBuf.join("\n")), language: "plain text" } });
  }
  return blocks;
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

// ─── Page content (read the body blocks of a page as plain text) ───────────────

/** Pull the plain-text content of a page's top-level blocks (paragraphs, lists,
 *  headings, to-dos, quotes). Used to feed a PRD / scoping doc to the AI. */
export async function getPageContent(userId: string, pageId: string): Promise<string> {
  const res = await notionFetch(userId, `/blocks/${pageId}/children?page_size=100`, { method: "GET" });
  if (!res.ok) return "";
  const data = (await res.json()) as {
    results?: { type?: string; [k: string]: unknown }[];
  };

  const lines: string[] = [];
  for (const block of data.results ?? []) {
    const type = block.type;
    if (!type) continue;
    // Each block nests its rich_text under a key matching its type.
    const payload = block[type] as { rich_text?: { plain_text?: string }[] } | undefined;
    const text = (payload?.rich_text ?? []).map((r) => r.plain_text ?? "").join("");
    if (!text.trim()) continue;
    if (type.startsWith("heading")) lines.push(`\n## ${text}`);
    else if (type === "bulleted_list_item" || type === "numbered_list_item") lines.push(`- ${text}`);
    else if (type === "to_do") lines.push(`- [ ] ${text}`);
    else lines.push(text);
  }
  return lines.join("\n").trim();
}
