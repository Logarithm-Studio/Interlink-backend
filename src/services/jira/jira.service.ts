/**
 * Jira Cloud (Atlassian) REST API service — OAuth 2.0 3LO, free.
 * Tokens stored (encrypted) in connected_integrations table.
 *
 * Notes specific to Atlassian:
 *  - Access tokens expire in ~1h; `offline_access` scope yields a refresh token.
 *  - Refresh tokens are ROTATING — each refresh returns a new refresh token that
 *    must replace the old one.
 *  - API calls are not made to a fixed host: after OAuth you resolve the
 *    `cloudId` (site id) via /oauth/token/accessible-resources, then call
 *    https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...
 */

import { getIntegration, upsertIntegration } from "../integrations/tokenStore";
import { BadRequestError } from "../../utils/errors";

const ATLASSIAN_AUTH = "https://auth.atlassian.com";
const ATLASSIAN_API = "https://api.atlassian.com";

// offline_access is appended here (it is not a console-selectable scope) so
// Atlassian returns a refresh token.
const JIRA_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "offline_access",
];

function clientId(): string {
  const id = process.env.JIRA_CLIENT_ID;
  if (!id) throw new Error("JIRA_CLIENT_ID is not configured.");
  return id;
}
function clientSecret(): string {
  const s = process.env.JIRA_CLIENT_SECRET;
  if (!s) throw new Error("JIRA_CLIENT_SECRET is not configured.");
  return s;
}
function redirectUri(): string {
  // Backend-mediated OAuth: Atlassian requires an https redirect_uri (custom
  // schemes are rejected). Atlassian redirects to our https callback, which
  // exchanges the code and then deep-links into the app. Override with
  // JIRA_REDIRECT_URI.
  return (
    process.env.JIRA_REDIRECT_URI ??
    `${process.env.API_BASE_URL ?? "http://localhost:5000"}/api/v1/jira/callback`
  );
}

interface JiraMetadata {
  cloudId?: string;
  siteUrl?: string;
  siteName?: string;
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: clientId(),
    scope: JIRA_SCOPES.join(" "),
    redirect_uri: redirectUri(),
    state,
    response_type: "code",
    // prompt=consent guarantees a refresh token is returned on re-authorization.
    prompt: "consent",
  });
  return `${ATLASSIAN_AUTH}/authorize?${params}`;
}

/** Resolve the first accessible Jira site (cloudId + url + name) for a token. */
async function fetchAccessibleResource(
  accessToken: string,
): Promise<JiraMetadata> {
  const res = await fetch(`${ATLASSIAN_API}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Jira accessible-resources failed: ${t.slice(0, 200)}`);
  }
  const sites = (await res.json()) as { id?: string; url?: string; name?: string }[];
  const first = sites[0];
  if (!first?.id) {
    throw new BadRequestError(
      "No Jira site is accessible for this account. Grant the app access to a site and reconnect.",
    );
  }
  return { cloudId: first.id, siteUrl: first.url, siteName: first.name };
}

export async function exchangeCode(userId: string, code: string): Promise<void> {
  const res = await fetch(`${ATLASSIAN_AUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Jira token exchange failed: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const meta = await fetchAccessibleResource(data.access_token);

  await upsertIntegration(
    userId,
    "jira",
    {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: JIRA_SCOPES,
    },
    meta as Record<string, unknown>,
  );
}

/** Refresh an expired access token; persists the rotated refresh token + cloudId. */
async function refreshAccessToken(
  userId: string,
  refreshToken: string,
  meta: JiraMetadata,
): Promise<string> {
  const res = await fetch(`${ATLASSIAN_AUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new BadRequestError(
      `Jira session expired and could not be refreshed. Reconnect Jira. (${t.slice(0, 120)})`,
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  await upsertIntegration(
    userId,
    "jira",
    {
      accessToken: data.access_token,
      // Atlassian rotates refresh tokens; fall back to the old one if omitted.
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: JIRA_SCOPES,
    },
    meta as Record<string, unknown>,
  );
  return data.access_token;
}

/** Returns a valid access token + cloudId, refreshing the token if needed. */
async function getAuth(userId: string): Promise<{ accessToken: string; cloudId: string }> {
  const integration = await getIntegration(userId, "jira");
  if (!integration || integration.status === "revoked") {
    throw new BadRequestError("Jira is not connected. Connect it from Settings → Connected Accounts.");
  }
  const meta = (integration.metadata ?? {}) as JiraMetadata;
  if (!meta.cloudId) {
    throw new BadRequestError("Jira connection is missing its site id. Reconnect Jira.");
  }

  let accessToken = integration.accessToken;
  const expired =
    integration.tokenExpiresAt != null &&
    integration.tokenExpiresAt.getTime() < Date.now() + 30_000; // 30s skew
  if (expired) {
    if (!integration.refreshToken) {
      throw new BadRequestError("Jira session expired. Reconnect Jira.");
    }
    accessToken = await refreshAccessToken(userId, integration.refreshToken, meta);
  }
  return { accessToken, cloudId: meta.cloudId };
}

async function jiraFetch(userId: string, path: string, opts: RequestInit = {}): Promise<Response> {
  const { accessToken, cloudId } = await getAuth(userId);
  return fetch(`${ATLASSIAN_API}/ex/jira/${cloudId}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

// ─── Projects ──────────────────────────────────────────────────────────────────

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export async function getProjects(userId: string): Promise<JiraProject[]> {
  const res = await jiraFetch(userId, "/rest/api/3/project/search?maxResults=50");
  if (!res.ok) return [];
  const data = (await res.json()) as { values?: { id?: string; key?: string; name?: string }[] };
  return (data.values ?? []).map((p) => ({ id: p.id ?? "", key: p.key ?? "", name: p.name ?? "" }));
}

// ─── Issues ────────────────────────────────────────────────────────────────────

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  priority: string | null;
  url: string;
}

function mapIssue(cloudSiteUrl: string, raw: {
  id?: string; key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
    priority?: { name?: string } | null;
  };
}): JiraIssue {
  return {
    id: raw.id ?? "",
    key: raw.key ?? "",
    summary: raw.fields?.summary ?? "",
    status: raw.fields?.status?.name ?? "",
    assignee: raw.fields?.assignee?.displayName ?? null,
    priority: raw.fields?.priority?.name ?? null,
    url: cloudSiteUrl && raw.key ? `${cloudSiteUrl}/browse/${raw.key}` : "",
  };
}

/** Run a JQL search. Defaults to the current user's open issues. */
export async function searchIssues(userId: string, jql?: string): Promise<JiraIssue[]> {
  const effectiveJql = jql?.trim() || "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";
  const params = new URLSearchParams({
    jql: effectiveJql,
    maxResults: "50",
    fields: "summary,status,assignee,priority",
  });
  const res = await jiraFetch(userId, `/rest/api/3/search?${params}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { issues?: Parameters<typeof mapIssue>[1][] };

  const integration = await getIntegration(userId, "jira");
  const siteUrl = ((integration?.metadata ?? {}) as JiraMetadata).siteUrl ?? "";
  return (data.issues ?? []).map((i) => mapIssue(siteUrl, i));
}

export async function createIssue(
  userId: string,
  data: { projectKey: string; summary: string; description?: string; issueType?: string },
): Promise<JiraIssue> {
  const body: Record<string, unknown> = {
    fields: {
      project: { key: data.projectKey },
      summary: data.summary,
      issuetype: { name: data.issueType ?? "Task" },
      ...(data.description
        ? {
            // Jira Cloud v3 uses Atlassian Document Format (ADF) for descriptions.
            description: {
              type: "doc",
              version: 1,
              content: [
                { type: "paragraph", content: [{ type: "text", text: data.description }] },
              ],
            },
          }
        : {}),
    },
  };

  const res = await jiraFetch(userId, "/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Failed to create Jira issue: ${t.slice(0, 200)}`);
  }
  const created = (await res.json()) as { id?: string; key?: string };
  const integration = await getIntegration(userId, "jira");
  const siteUrl = ((integration?.metadata ?? {}) as JiraMetadata).siteUrl ?? "";
  return {
    id: created.id ?? "",
    key: created.key ?? "",
    summary: data.summary,
    status: "To Do",
    assignee: null,
    priority: null,
    url: siteUrl && created.key ? `${siteUrl}/browse/${created.key}` : "",
  };
}

/** Current authenticated Jira user (for connection verification). */
export async function getMyself(userId: string): Promise<{ accountId: string; displayName: string; email: string | null }> {
  const res = await jiraFetch(userId, "/rest/api/3/myself");
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Jira /myself failed: ${t.slice(0, 200)}`);
  }
  const d = (await res.json()) as { accountId?: string; displayName?: string; emailAddress?: string };
  return { accountId: d.accountId ?? "", displayName: d.displayName ?? "", email: d.emailAddress ?? null };
}
