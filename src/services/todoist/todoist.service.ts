/**
 * Todoist REST API v2 service.
 * Tokens stored in connected_integrations table.
 */

import { getIntegration, upsertIntegration } from "../integrations/tokenStore";
import { BadRequestError } from "../../utils/errors";

const TODOIST_BASE = "https://api.todoist.com/rest/v2";
const TODOIST_SYNC = "https://todoist.com/oauth";

function clientId(): string {
  const id = process.env.TODOIST_CLIENT_ID;
  if (!id) throw new Error("TODOIST_CLIENT_ID is not configured.");
  return id;
}
function clientSecret(): string {
  const s = process.env.TODOIST_CLIENT_SECRET;
  if (!s) throw new Error("TODOIST_CLIENT_SECRET is not configured.");
  return s;
}
function redirectUri(): string {
  // Mobile OAuth: redirect to the app's custom scheme; the app completes the
  // exchange via /auth/callback. Override with TODOIST_REDIRECT_URI.
  return process.env.TODOIST_REDIRECT_URI ?? "interlinkapp://oauth/todoist";
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    scope: "data:read_write",
    state,
  });
  return `${TODOIST_SYNC}/authorize?${params}`;
}

export async function exchangeCode(userId: string, code: string): Promise<void> {
  const res = await fetch(`${TODOIST_SYNC}/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      redirect_uri: redirectUri(),
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Todoist token exchange failed: ${t.slice(0, 200)}`);
  }

  const data = (await res.json()) as { access_token: string; token_type: string };
  await upsertIntegration(userId, "todoist", {
    accessToken: data.access_token,
    scopes: ["data:read_write"],
  });
}

// ─── Authed fetch ────────────────────────────────────────────────────────────

async function todoistFetch(userId: string, path: string, opts: RequestInit = {}): Promise<Response> {
  const integration = await getIntegration(userId, "todoist");
  if (!integration || integration.status === "revoked") {
    throw new BadRequestError("Todoist is not connected. Connect it from Settings → Connected Accounts.");
  }

  return fetch(`${TODOIST_BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      Authorization: `Bearer ${integration.accessToken}`,
    },
  });
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export interface TodoistProject {
  id: string;
  name: string;
  color: string;
  isFavorite: boolean;
}

export interface TodoistTask {
  id: string;
  content: string;
  description: string;
  projectId: string;
  priority: number;
  due: { date: string; string: string } | null;
  isCompleted: boolean;
  createdAt: string;
  labels: string[];
}

export async function getProjects(userId: string): Promise<TodoistProject[]> {
  const res = await todoistFetch(userId, "/projects");
  if (!res.ok) return [];
  const items = (await res.json()) as {
    id?: string; name?: string; color?: string; is_favorite?: boolean;
  }[];
  return items.map((p) => ({
    id: p.id!,
    name: p.name ?? "",
    color: p.color ?? "charcoal",
    isFavorite: p.is_favorite ?? false,
  }));
}

export async function getTasks(userId: string, projectId?: string): Promise<TodoistTask[]> {
  const params = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  const res = await todoistFetch(userId, `/tasks${params}`);
  if (!res.ok) return [];
  const items = (await res.json()) as {
    id?: string; content?: string; description?: string; project_id?: string;
    priority?: number; due?: { date?: string; string?: string } | null;
    is_completed?: boolean; created_at?: string; labels?: string[];
  }[];
  return items.map((t) => ({
    id: t.id!,
    content: t.content ?? "",
    description: t.description ?? "",
    projectId: t.project_id ?? "",
    priority: t.priority ?? 1,
    due: t.due ? { date: t.due.date ?? "", string: t.due.string ?? "" } : null,
    isCompleted: t.is_completed ?? false,
    createdAt: t.created_at ?? new Date().toISOString(),
    labels: t.labels ?? [],
  }));
}

export async function createTask(
  userId: string,
  data: { content: string; dueString?: string; priority?: number; projectId?: string },
): Promise<TodoistTask> {
  const res = await todoistFetch(userId, "/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: data.content,
      due_string: data.dueString,
      priority: data.priority ?? 1,
      project_id: data.projectId,
    }),
  });

  if (!res.ok) throw new Error("Failed to create Todoist task");
  const t = (await res.json()) as Record<string, unknown>;
  return {
    id: (t as { id: string }).id,
    content: (t as { content?: string }).content ?? "",
    description: (t as { description?: string }).description ?? "",
    projectId: (t as { project_id?: string }).project_id ?? "",
    priority: (t as { priority?: number }).priority ?? 1,
    due: (t as { due?: { date?: string; string?: string } | null }).due
      ? { date: ((t as { due?: { date?: string } }).due?.date ?? ""), string: ((t as { due?: { string?: string } }).due?.string ?? "") }
      : null,
    isCompleted: false,
    createdAt: (t as { created_at?: string }).created_at ?? new Date().toISOString(),
    labels: (t as { labels?: string[] }).labels ?? [],
  };
}

export async function closeTask(userId: string, taskId: string): Promise<void> {
  await todoistFetch(userId, `/tasks/${taskId}/close`, { method: "POST" });
}
