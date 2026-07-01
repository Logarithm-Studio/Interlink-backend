/**
 * Product Manager vertical (Professional Mode).
 * No dedicated data model — wraps the already-connected GitHub integration so
 * the agent can read repos/PRs/issues and create issues on confirmation.
 */

import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { getRepos, getPullRequests, getIssues, createIssue } from "../../pm/github.service";
import type { GeminiToolFunction } from "../../ai/geminiClient";
import type { PersonaVertical } from "../registry";

const PERSONA = "product_manager";

function splitRepo(full: string): { owner: string; repo: string } | null {
  const [owner, repo] = full.split("/");
  return owner && repo ? { owner, repo } : null;
}

async function buildSnapshot(userId: string): Promise<string> {
  const repos = await getRepos(userId).catch(() => []);
  if (repos.length === 0) {
    return "GitHub is not connected yet (or no repos). Ask the user to connect GitHub in Settings → Manage Integrations to enable PR/issue workflows.";
  }
  return [
    `Connected GitHub repos: ${repos.length}.`,
    "Repos (name | open issues | language):",
    ...repos.slice(0, 20).map((r) => `- ${r.fullName} | ${r.openIssues} open | ${r.language ?? "—"}`),
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are the user's AI product-manager assistant inside the Interlink app.",
  "You work over the user's connected GitHub repos (see DATA SNAPSHOT). Answer questions,",
  "or perform ONE action by calling a function when asked (e.g. create an issue).",
  "Use the exact repo full-name (owner/name) from the snapshot. You never write anything",
  "yourself — the app confirms before executing.",
].join("\n");

const TOOLS: GeminiToolFunction[] = [
  { name: "create_issue", description: "Create a GitHub issue in a repo.", parameters: { type: "object", properties: { repo: { type: "string", description: "owner/name from the snapshot." }, title: { type: "string" }, body: { type: "string" } }, required: ["repo", "title"] } },
  { name: "summarize_prs", description: "Summarize open pull requests for a repo.", parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
  { name: "generate_standup", description: "Generate a standup summary (open PRs + issues) for a repo.", parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
];

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "create_issue": return `Create issue "${args.title ?? ""}" in ${args.repo ?? "repo"}.`;
    case "summarize_prs": return `Summarize open PRs in ${args.repo ?? "repo"}.`;
    case "generate_standup": return `Generate a standup for ${args.repo ?? "repo"}.`;
    default: return `Run ${name}.`;
  }
}

async function executeTool(user: AppUser, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const parts = splitRepo(String(args.repo ?? ""));
  if (!parts) return { ok: false, message: "Please specify the repo as owner/name." };
  try {
    switch (name) {
      case "create_issue": {
        const issue = await createIssue(user.id, parts.owner, parts.repo, { title: String(args.title ?? "").trim(), body: args.body ? String(args.body) : undefined });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "issue_created", title: `Opened #${issue.number} in ${args.repo}`, detail: issue.title, entityType: "github_issue", entityId: String(issue.number) });
        return { ok: true, message: `Created issue #${issue.number}: ${issue.title}.` };
      }
      case "summarize_prs": {
        const prs = await getPullRequests(user.id, parts.owner, parts.repo);
        if (prs.length === 0) return { ok: true, message: "No open pull requests." };
        return { ok: true, message: `Open PRs in ${args.repo}:\n` + prs.slice(0, 15).map((p) => `- #${p.number} ${p.title} (${p.author})`).join("\n") };
      }
      case "generate_standup": {
        const [prs, issues] = await Promise.all([getPullRequests(user.id, parts.owner, parts.repo), getIssues(user.id, parts.owner, parts.repo)]);
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "standup_generated", title: `Standup for ${args.repo}` });
        return { ok: true, message: `Standup — ${args.repo}\nOpen PRs: ${prs.length}\n` + prs.slice(0, 8).map((p) => `- #${p.number} ${p.title}`).join("\n") + `\nOpen issues: ${issues.length}\n` + issues.slice(0, 8).map((i) => `- #${i.number} ${i.title}`).join("\n") };
      }
      default:
        return { ok: false, message: `Unsupported action: ${name}.` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export const pmVertical: PersonaVertical = {
  persona: PERSONA,
  tools: TOOLS,
  systemPrompt: SYSTEM_PROMPT,
  buildSnapshot,
  executeTool,
  summarizeAction,
  // No seedDemo — PM works over live GitHub data.
};
