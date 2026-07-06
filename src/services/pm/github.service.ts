/**
 * GitHub REST API service (OAuth, free).
 * Tokens stored in connected_integrations table.
 */

import { getIntegration, upsertIntegration, updateAccessToken } from "../integrations/tokenStore";
import { BadRequestError } from "../../utils/errors";

const GITHUB_BASE = "https://api.github.com";
const GITHUB_OAUTH = "https://github.com";

function clientId(): string {
  const id = process.env.GITHUB_CLIENT_ID;
  if (!id) throw new Error("GITHUB_CLIENT_ID is not configured.");
  return id;
}
function clientSecret(): string {
  const s = process.env.GITHUB_CLIENT_SECRET;
  if (!s) throw new Error("GITHUB_CLIENT_SECRET is not configured.");
  return s;
}
function redirectUri(): string {
  // Backend-mediated OAuth: GitHub redirects to our https callback (custom
  // schemes trigger a "redirecting to the authorized application" interstitial
  // that never hands back to the app). The callback exchanges the code and then
  // deep-links into the app. Override with GITHUB_REDIRECT_URI.
  return (
    process.env.GITHUB_REDIRECT_URI ??
    `${process.env.API_BASE_URL ?? "http://localhost:5000"}/api/v1/pm/github/callback`
  );
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    scope: "repo read:user",
    state,
  });
  return `${GITHUB_OAUTH}/login/oauth/authorize?${params}`;
}

export async function exchangeCode(userId: string, code: string): Promise<void> {
  const res = await fetch(`${GITHUB_OAUTH}/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId(), client_secret: clientSecret(), code, redirect_uri: redirectUri() }),
  });
  if (!res.ok) throw new Error("GitHub token exchange failed");
  const data = (await res.json()) as { access_token?: string; scope?: string };
  if (!data.access_token) throw new Error("GitHub did not return an access token");
  await upsertIntegration(userId, "github", {
    accessToken: data.access_token,
    scopes: (data.scope ?? "").split(","),
  });
}

async function ghFetch(userId: string, path: string, opts: RequestInit = {}): Promise<Response> {
  const integration = await getIntegration(userId, "github");
  if (!integration || integration.status === "revoked") {
    throw new BadRequestError("GitHub is not connected. Connect it from Settings → Connected Accounts.");
  }
  return fetch(`${GITHUB_BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      Authorization: `Bearer ${integration.accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

// ─── Repos ────────────────────────────────────────────────────────────────────

export interface GitHubRepo {
  id: number;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  language: string | null;
  isPrivate: boolean;
  htmlUrl: string;
  openIssues: number;
}

export async function getRepos(userId: string): Promise<GitHubRepo[]> {
  const res = await ghFetch(userId, "/user/repos?sort=pushed&per_page=30&type=owner");
  if (!res.ok) return [];
  const items = (await res.json()) as {
    id?: number; full_name?: string; description?: string | null;
    default_branch?: string; language?: string | null; private?: boolean;
    html_url?: string; open_issues_count?: number;
  }[];
  return items.map((r) => ({
    id: r.id!,
    fullName: r.full_name ?? "",
    description: r.description ?? null,
    defaultBranch: r.default_branch ?? "main",
    language: r.language ?? null,
    isPrivate: r.private ?? false,
    htmlUrl: r.html_url ?? "",
    openIssues: r.open_issues_count ?? 0,
  }));
}

// ─── Pull Requests ────────────────────────────────────────────────────────────

export interface GitHubPR {
  id: number;
  number: number;
  title: string;
  state: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  draft: boolean;
  reviewsRequested: string[];
}

export async function getPullRequests(userId: string, owner: string, repo: string): Promise<GitHubPR[]> {
  const res = await ghFetch(userId, `/repos/${owner}/${repo}/pulls?state=open&per_page=30`);
  if (!res.ok) return [];
  const items = (await res.json()) as {
    id?: number; number?: number; title?: string; state?: string;
    user?: { login?: string }; created_at?: string; updated_at?: string;
    html_url?: string; draft?: boolean;
    requested_reviewers?: { login?: string }[];
  }[];
  return items.map((pr) => ({
    id: pr.id!,
    number: pr.number!,
    title: pr.title ?? "",
    state: pr.state ?? "open",
    author: pr.user?.login ?? "",
    createdAt: pr.created_at ?? "",
    updatedAt: pr.updated_at ?? "",
    htmlUrl: pr.html_url ?? "",
    draft: pr.draft ?? false,
    reviewsRequested: (pr.requested_reviewers ?? []).map((r) => r.login ?? ""),
  }));
}

/**
 * Recently MERGED pull requests (for release notes). The list endpoint has no
 * "merged" state, so we fetch closed PRs newest-first and keep only those with a
 * `merged_at` timestamp (closed-unmerged PRs are dropped).
 */
export async function getMergedPullRequests(userId: string, owner: string, repo: string): Promise<GitHubPR[]> {
  const res = await ghFetch(userId, `/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`);
  if (!res.ok) return [];
  const items = (await res.json()) as {
    id?: number; number?: number; title?: string; state?: string;
    user?: { login?: string }; created_at?: string; updated_at?: string;
    html_url?: string; draft?: boolean; merged_at?: string | null;
    requested_reviewers?: { login?: string }[];
  }[];
  return items
    .filter((pr) => pr.merged_at)
    .map((pr) => ({
      id: pr.id!,
      number: pr.number!,
      title: pr.title ?? "",
      state: "merged",
      author: pr.user?.login ?? "",
      createdAt: pr.created_at ?? "",
      updatedAt: pr.updated_at ?? "",
      htmlUrl: pr.html_url ?? "",
      draft: pr.draft ?? false,
      reviewsRequested: (pr.requested_reviewers ?? []).map((r) => r.login ?? ""),
    }));
}

// ─── Issues ───────────────────────────────────────────────────────────────────

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  author: string;
  createdAt: string;
  htmlUrl: string;
  labels: string[];
  assignees: string[];
}

export async function getIssues(userId: string, owner: string, repo: string): Promise<GitHubIssue[]> {
  const res = await ghFetch(userId, `/repos/${owner}/${repo}/issues?state=open&per_page=30`);
  if (!res.ok) return [];
  const items = (await res.json()) as {
    id?: number; number?: number; title?: string; state?: string;
    user?: { login?: string }; created_at?: string; html_url?: string;
    pull_request?: unknown; labels?: { name?: string }[];
    assignees?: { login?: string }[];
  }[];
  return items
    .filter((i) => !i.pull_request)
    .map((i) => ({
      id: i.id!,
      number: i.number!,
      title: i.title ?? "",
      state: i.state ?? "open",
      author: i.user?.login ?? "",
      createdAt: i.created_at ?? "",
      htmlUrl: i.html_url ?? "",
      labels: (i.labels ?? []).map((l) => l.name ?? ""),
      assignees: (i.assignees ?? []).map((a) => a.login ?? ""),
    }));
}

export async function createIssue(
  userId: string,
  owner: string,
  repo: string,
  data: { title: string; body?: string; labels?: string[] },
): Promise<GitHubIssue> {
  const res = await ghFetch(userId, `/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: data.title, body: data.body, labels: data.labels }),
  });
  if (!res.ok) throw new Error("Failed to create GitHub issue");
  const i = (await res.json()) as Record<string, unknown>;
  return {
    id: (i as { id: number }).id,
    number: (i as { number: number }).number,
    title: (i as { title: string }).title,
    state: "open",
    author: ((i as { user?: { login?: string } }).user?.login ?? ""),
    createdAt: (i as { created_at?: string }).created_at ?? new Date().toISOString(),
    htmlUrl: (i as { html_url?: string }).html_url ?? "",
    labels: ((i as { labels?: { name?: string }[] }).labels ?? []).map((l) => l.name ?? ""),
    assignees: [],
  };
}
