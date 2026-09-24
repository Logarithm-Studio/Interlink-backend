/**
 * Todoist API v1 integration. Tokens are encrypted in connected_integrations.
 * Todoist rotates OAuth refresh tokens, so refresh responses must be saved before
 * another request can use them.
 */

import { query } from "../../config/db";
import { BadRequestError } from "../../utils/errors";
import { getIntegration, upsertIntegration } from "../integrations/tokenStore";

const TODOIST_API_BASE = "https://api.todoist.com/api/v1";
const TODOIST_AUTH_BASE = "https://app.todoist.com/oauth";
const TODOIST_TOKEN_URL = "https://api.todoist.com/oauth/access_token";
const TOKEN_REFRESH_BUFFER_MS = 3 * 60_000;
const MAX_PAGES = 50;

function clientId(): string {
  const id = process.env.TODOIST_CLIENT_ID;
  if (!id) throw new Error("TODOIST_CLIENT_ID is not configured.");
  return id;
}
function clientSecret(): string {
  const secret = process.env.TODOIST_CLIENT_SECRET;
  if (!secret) throw new Error("TODOIST_CLIENT_SECRET is not configured.");
  return secret;
}
function redirectUri(): string {
  return process.env.TODOIST_REDIRECT_URI ??
    `${process.env.API_BASE_URL ?? "http://localhost:5000"}/api/v1/todoist/callback`;
}

interface TodoistOAuthTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

function tokenExpiry(expiresIn: unknown): Date | undefined {
  return typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000)
    : undefined;
}

function parseScopes(scope: string | undefined): string[] {
  const values = scope?.split(/[\s,]+/).filter(Boolean);
  return values?.length ? values : ["data:read_write"];
}

function tokenForm(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...values });
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    scope: "data:read_write",
    state,
    response_type: "code",
    redirect_uri: redirectUri(),
  });
  return `${TODOIST_AUTH_BASE}/authorize?${params}`;
}

export async function exchangeCode(userId: string, code: string): Promise<void> {
  const res = await fetch(TODOIST_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenForm({ code, redirect_uri: redirectUri() }),
  });
  const data = await res.json().catch(() => ({})) as TodoistOAuthTokens;
  if (!res.ok || !data.access_token) {
    throw new Error(`Todoist token exchange failed (${data.error ?? res.status}).`);
  }
  await upsertIntegration(userId, "todoist", {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: tokenExpiry(data.expires_in),
    scopes: parseScopes(data.scope),
  });
}

async function requireReauthorization(userId: string): Promise<void> {
  await query(
    `UPDATE connected_integrations SET status='reauth_required',updated_at=now()
      WHERE user_id=$1 AND provider='todoist' AND status<>'revoked'`, [userId],
  );
}

const refreshes = new Map<string, Promise<string>>();

async function refreshAccessToken(
  userId: string,
  observedAccessToken: string,
  force = false,
): Promise<string> {
  const existingRefresh = refreshes.get(userId);
  if (existingRefresh) return existingRefresh;

  const refreshPromise = (async () => {
    let integration = await getIntegration(userId, "todoist");
    if (!integration || integration.status === "revoked" || integration.status === "reauth_required") {
      throw new BadRequestError("Todoist needs to be reconnected. Open Settings → Connected Accounts and reconnect it.");
    }
    // Another request or server instance may have refreshed the token since this
    // request read it. Reuse that fresh token instead of rotating twice.
    if (integration.accessToken !== observedAccessToken &&
      (!integration.tokenExpiresAt || integration.tokenExpiresAt.getTime() > Date.now() + TOKEN_REFRESH_BUFFER_MS)) {
      return integration.accessToken;
    }
    if (!force && integration.tokenExpiresAt && integration.tokenExpiresAt.getTime() > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
      return integration.accessToken;
    }
    if (!integration.refreshToken) {
      await requireReauthorization(userId);
      throw new BadRequestError("Todoist needs to be reconnected. Open Settings → Connected Accounts and reconnect it.");
    }

    const res = await fetch(TODOIST_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenForm({ grant_type: "refresh_token", refresh_token: integration.refreshToken }),
    });
    const data = await res.json().catch(() => ({})) as TodoistOAuthTokens;
    if (!res.ok || !data.access_token) {
      if (res.status === 400 || res.status === 401) {
        await requireReauthorization(userId);
        throw new BadRequestError("Todoist authorization expired. Reconnect Todoist in Settings → Connected Accounts.");
      }
      throw new Error(`Todoist token refresh failed (${data.error ?? res.status}).`);
    }

    if (!data.refresh_token) {
      // A grace-window retry can return the rotated access token without the new
      // refresh token. Accept it only when another request has already persisted
      // the rotation; never overwrite that rotation with the consumed old token.
      const latest = await getIntegration(userId, "todoist");
      if (latest && latest.accessToken === data.access_token && latest.updatedAt.getTime() > integration.updatedAt.getTime()) {
        return latest.accessToken;
      }
      await requireReauthorization(userId);
      throw new BadRequestError("Todoist could not safely refresh its rotating token. Reconnect Todoist in Settings → Connected Accounts.");
    }

    await upsertIntegration(userId, "todoist", {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: tokenExpiry(data.expires_in),
      scopes: parseScopes(data.scope),
    });
    integration = await getIntegration(userId, "todoist");
    return integration?.accessToken ?? data.access_token;
  })();

  refreshes.set(userId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    if (refreshes.get(userId) === refreshPromise) refreshes.delete(userId);
  }
}

async function todoistFetch(userId: string, path: string, opts: RequestInit = {}): Promise<Response> {
  let integration = await getIntegration(userId, "todoist");
  if (!integration || integration.status === "revoked" || integration.status === "reauth_required") {
    throw new BadRequestError("Todoist is not connected or needs to be reconnected. Open Settings → Connected Accounts.");
  }
  let accessToken = integration.tokenExpiresAt &&
    integration.tokenExpiresAt.getTime() <= Date.now() + TOKEN_REFRESH_BUFFER_MS
    ? await refreshAccessToken(userId, integration.accessToken)
    : integration.accessToken;

  const request = (token: string) => fetch(`${TODOIST_API_BASE}${path}`, {
    ...opts,
    headers: { ...(opts.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  let response = await request(accessToken);
  if (response.status === 401) {
    accessToken = await refreshAccessToken(userId, accessToken, true);
    response = await request(accessToken);
    if (response.status === 401) {
      await requireReauthorization(userId);
      throw new BadRequestError("Todoist authorization expired. Reconnect Todoist in Settings → Connected Accounts.");
    }
  }
  return response;
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_tag?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.error_tag === "string" ? parsed.error_tag : "";
    return message ? ` ${message.slice(0, 160)}` : "";
  } catch {
    return body ? ` ${body.slice(0, 160)}` : "";
  }
}

async function getPaginated<T>(userId: string, path: string, params: URLSearchParams, pageSize = 200): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", String(pageSize));
    if (cursor) pageParams.set("cursor", cursor);
    const response = await todoistFetch(userId, `${path}?${pageParams.toString()}`);
    if (!response.ok) throw new Error(`Todoist request failed (${response.status}).${await readError(response)}`);
    const payload = await response.json() as { results?: T[]; items?: T[]; next_cursor?: string | null } | T[];
    if (Array.isArray(payload)) return payload;
    items.push(...(Array.isArray(payload.results) ? payload.results : Array.isArray(payload.items) ? payload.items : []));
    cursor = typeof payload.next_cursor === "string" && payload.next_cursor ? payload.next_cursor : null;
    if (!cursor) return items;
  }
  throw new Error(`Todoist returned more than ${MAX_PAGES * pageSize} records. Narrow the date or project filter and try again.`);
}

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
  const records = await getPaginated<Record<string, unknown>>(userId, "/projects", new URLSearchParams());
  return records.flatMap((project) => typeof project.id === "string" ? [{
    id: project.id,
    name: typeof project.name === "string" ? project.name : "",
    color: typeof project.color === "string" ? project.color : "charcoal",
    isFavorite: project.is_favorite === true,
  }] : []);
}

function mapTask(task: Record<string, unknown>): TodoistTask | null {
  if (typeof task.id !== "string") return null;
  const due = task.due && typeof task.due === "object" ? task.due as Record<string, unknown> : null;
  return {
    id: task.id,
    content: typeof task.content === "string" ? task.content : "",
    description: typeof task.description === "string" ? task.description : "",
    projectId: typeof task.project_id === "string" ? task.project_id : "",
    priority: typeof task.priority === "number" ? task.priority : 1,
    due: due ? {
      date: typeof due.date === "string" ? due.date : "",
      string: typeof due.string === "string" ? due.string : "",
    } : null,
    isCompleted: task.checked === true || task.is_completed === true,
    createdAt: typeof task.added_at === "string" ? task.added_at : typeof task.created_at === "string" ? task.created_at : new Date().toISOString(),
    labels: Array.isArray(task.labels) ? task.labels.filter((label): label is string => typeof label === "string") : [],
  };
}

export async function getTasks(userId: string, projectId?: string): Promise<TodoistTask[]> {
  const params = new URLSearchParams();
  if (projectId) params.set("project_id", projectId);
  const records = await getPaginated<Record<string, unknown>>(userId, "/tasks", params);
  return records.map(mapTask).filter((task): task is TodoistTask => task !== null);
}

/** Todoist exposes completed task history for at most three months at a time. */
export async function getCompletedTasks(userId: string, since: Date, until = new Date()): Promise<TodoistTask[]> {
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since >= until) {
    throw new BadRequestError("Choose a valid Todoist completion history range.");
  }
  const params = new URLSearchParams({ since: since.toISOString(), until: until.toISOString() });
  const records = await getPaginated<Record<string, unknown>>(userId, "/tasks/completed/by_completion_date", params, 50);
  return records.map((record) => {
    const task = mapTask(record);
    return task ? { ...task, isCompleted: true } : null;
  }).filter((task): task is TodoistTask => task !== null);
}

export async function createTask(
  userId: string,
  data: { content: string; description?: string; dueString?: string; dueDatetime?: string; priority?: number; projectId?: string },
): Promise<TodoistTask> {
  const body = {
    content: data.content,
    description: data.description,
    due_string: data.dueDatetime ? undefined : data.dueString,
    due_datetime: data.dueDatetime,
    priority: data.priority ?? 1,
    project_id: data.projectId,
  };
  const res = await todoistFetch(userId, "/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to create Todoist task (${res.status}).${await readError(res)}`);
  const task = mapTask(await res.json() as Record<string, unknown>);
  if (!task) throw new Error("Todoist created a task but did not return its id.");
  return task;
}

export async function closeTask(userId: string, taskId: string): Promise<void> {
  const response = await todoistFetch(userId, `/tasks/${encodeURIComponent(taskId)}/close`, { method: "POST" });
  if (!response.ok) throw new Error(`Failed to complete Todoist task (${response.status}).${await readError(response)}`);
}
