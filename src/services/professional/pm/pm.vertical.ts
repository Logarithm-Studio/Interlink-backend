/**
 * Product Manager vertical (Professional Mode).
 *
 * Wraps the user's connected engineering apps (GitHub, Jira, Notion, Slack) so
 * the agent can read/act across them. Beyond the GitHub basics (issues, PRs,
 * standup) it implements the five PM PRD workflows in `pm-integrations.ts`:
 *   1. PRD → Jira tickets   2. Sprint interruption warning   3. Release notes
 *   4. Cross-functional status sync   5. Scope-creep protection
 * Every tool degrades gracefully when its integration isn't connected.
 */

import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { getRepos, getPullRequests, getIssues, createIssue } from "../../pm/github.service";
import {
  pmConnections,
  connectionsLine,
  prdToTickets,
  sprintInterruption,
  releaseNotes,
  statusSync,
  scopeCreepCheck,
} from "./pm-integrations";
import type { GeminiToolFunction } from "../../ai/geminiClient";
import type { AutomationProposal, PersonaVertical } from "../registry";

const PERSONA = "product_manager";

function splitRepo(full: string): { owner: string; repo: string } | null {
  const [owner, repo] = String(full ?? "").split("/");
  return owner && repo ? { owner, repo } : null;
}

async function buildSnapshot(userId: string): Promise<string> {
  const conns = await pmConnections(userId);
  const repos = conns.github ? await getRepos(userId).catch(() => []) : [];
  const lines = [connectionsLine(conns)];
  if (repos.length > 0) {
    lines.push(
      `GitHub repos: ${repos.length}.`,
      "Repos (name | open issues | language):",
      ...repos.slice(0, 20).map((r) => `- ${r.fullName} | ${r.openIssues} open | ${r.language ?? "—"}`),
    );
  } else if (conns.github) {
    lines.push("GitHub is connected but no repos were returned.");
  }
  if (!conns.github && !conns.jira && !conns.notion) {
    lines.push("Connect GitHub, Jira, Notion, and Slack in Settings → Manage Integrations to unlock the PM workflows.");
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT = [
  "You are the user's AI product-manager assistant inside the Interlink app.",
  "You work across the user's connected apps — GitHub, Jira, Notion, and Slack (see DATA SNAPSHOT",
  "for what's connected). Answer questions, or perform ONE action by calling a function when asked.",
  "Key workflows: turn a Notion PRD into Jira tickets (prd_to_tickets); log a critical defect and",
  "alert the team (sprint_interruption); draft & publish release notes from GitHub PRs (release_notes);",
  "compile a cross-functional status update (status_sync); check a client request for scope creep and",
  "draft a change order (scope_creep_check). Use exact repo full-names (owner/name) from the snapshot.",
  "You never write anything yourself — the app confirms before executing.",
].join("\n");

const TOOLS: GeminiToolFunction[] = [
  { name: "create_issue", description: "Create a GitHub issue in a repo.", parameters: { type: "object", properties: { repo: { type: "string", description: "owner/name from the snapshot." }, title: { type: "string" }, body: { type: "string" } }, required: ["repo", "title"] } },
  { name: "summarize_prs", description: "Summarize open pull requests for a GitHub repo.", parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
  { name: "generate_standup", description: "Generate a standup summary (open PRs + issues) for a GitHub repo.", parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
  { name: "prd_to_tickets", description: "Read a Notion PRD page and create Jira tickets (user stories with technical scope).", parameters: { type: "object", properties: { notionPageQuery: { type: "string", description: "Title (or part) of the Notion PRD page." }, notionPageId: { type: "string" }, projectKey: { type: "string", description: "Jira project key (defaults to the first project)." } } } },
  { name: "sprint_interruption", description: "Log a flagged critical defect in Jira on the least-loaded developer and alert the team on Slack.", parameters: { type: "object", properties: { defect: { type: "string", description: "The defect description (pasted)." }, slackChannel: { type: "string", description: "Channel id to read the bug from and/or alert." }, alertChannel: { type: "string" }, projectKey: { type: "string" } } } },
  { name: "release_notes", description: "Draft consumer-facing release notes from a GitHub repo's PRs and publish to Notion/Slack.", parameters: { type: "object", properties: { repo: { type: "string" }, slackChannel: { type: "string" }, notionParentId: { type: "string" } }, required: ["repo"] } },
  { name: "status_sync", description: "Compile a cross-functional status update from GitHub + Jira and publish to Notion/Slack.", parameters: { type: "object", properties: { repo: { type: "string" }, slackChannel: { type: "string" }, notionParentId: { type: "string" } } } },
  { name: "scope_creep_check", description: "Compare a client feature-amendment against the baseline scope (Notion) and draft a change-order notice.", parameters: { type: "object", properties: { amendmentText: { type: "string" }, baselineQuery: { type: "string", description: "Title of the baseline scoping doc in Notion." }, baselinePageId: { type: "string" }, baselineText: { type: "string" } }, required: ["amendmentText"] } },
];

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "create_issue": return `Create issue "${args.title ?? ""}" in ${args.repo ?? "repo"}.`;
    case "summarize_prs": return `Summarize open PRs in ${args.repo ?? "repo"}.`;
    case "generate_standup": return `Generate a standup for ${args.repo ?? "repo"}.`;
    case "prd_to_tickets": return `Turn the Notion PRD${args.notionPageQuery ? ` "${args.notionPageQuery}"` : ""} into Jira tickets.`;
    case "sprint_interruption": return `Log the critical defect in Jira and alert the team on Slack.`;
    case "release_notes": return `Draft & publish release notes for ${args.repo ?? "repo"}.`;
    case "status_sync": return `Compile & publish a cross-functional status update.`;
    case "scope_creep_check": return `Check the client request for scope creep and draft a change order.`;
    default: return `Run ${name}.`;
  }
}

async function executeTool(user: AppUser, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    switch (name) {
      // ─── GitHub basics ──────────────────────────────────────────────────────
      case "create_issue": {
        const parts = splitRepo(String(args.repo ?? ""));
        if (!parts) return { ok: false, message: "Please specify the repo as owner/name." };
        const issue = await createIssue(user.id, parts.owner, parts.repo, { title: String(args.title ?? "").trim(), body: args.body ? String(args.body) : undefined });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "issue_created", title: `Opened #${issue.number} in ${args.repo}`, detail: issue.title, entityType: "github_issue", entityId: String(issue.number) });
        return { ok: true, message: `Created issue #${issue.number}: ${issue.title}.` };
      }
      case "summarize_prs": {
        const parts = splitRepo(String(args.repo ?? ""));
        if (!parts) return { ok: false, message: "Please specify the repo as owner/name." };
        const prs = await getPullRequests(user.id, parts.owner, parts.repo);
        if (prs.length === 0) return { ok: true, message: "No open pull requests." };
        return { ok: true, message: `Open PRs in ${args.repo}:\n` + prs.slice(0, 15).map((p) => `- #${p.number} ${p.title} (${p.author})`).join("\n") };
      }
      case "generate_standup": {
        const parts = splitRepo(String(args.repo ?? ""));
        if (!parts) return { ok: false, message: "Please specify the repo as owner/name." };
        const [prs, issues] = await Promise.all([getPullRequests(user.id, parts.owner, parts.repo), getIssues(user.id, parts.owner, parts.repo)]);
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "standup_generated", title: `Standup for ${args.repo}` });
        return { ok: true, message: `Standup — ${args.repo}\nOpen PRs: ${prs.length}\n` + prs.slice(0, 8).map((p) => `- #${p.number} ${p.title}`).join("\n") + `\nOpen issues: ${issues.length}\n` + issues.slice(0, 8).map((i) => `- #${i.number} ${i.title}`).join("\n") };
      }
      // ─── PRD workflows (multi-app) ──────────────────────────────────────────
      case "prd_to_tickets":
        return prdToTickets(user, { notionPageId: args.notionPageId ? String(args.notionPageId) : undefined, notionPageQuery: args.notionPageQuery ? String(args.notionPageQuery) : undefined, projectKey: args.projectKey ? String(args.projectKey) : undefined });
      case "sprint_interruption":
        return sprintInterruption(user, { defect: args.defect ? String(args.defect) : undefined, slackChannel: args.slackChannel ? String(args.slackChannel) : undefined, alertChannel: args.alertChannel ? String(args.alertChannel) : undefined, projectKey: args.projectKey ? String(args.projectKey) : undefined });
      case "release_notes":
        return releaseNotes(user, { repo: args.repo ? String(args.repo) : undefined, notionParentId: args.notionParentId ? String(args.notionParentId) : undefined, slackChannel: args.slackChannel ? String(args.slackChannel) : undefined });
      case "status_sync":
        return statusSync(user, { repo: args.repo ? String(args.repo) : undefined, notionParentId: args.notionParentId ? String(args.notionParentId) : undefined, slackChannel: args.slackChannel ? String(args.slackChannel) : undefined });
      case "scope_creep_check":
        return scopeCreepCheck(user, { amendmentText: args.amendmentText ? String(args.amendmentText) : undefined, baselinePageId: args.baselinePageId ? String(args.baselinePageId) : undefined, baselineQuery: args.baselineQuery ? String(args.baselineQuery) : undefined, baselineText: args.baselineText ? String(args.baselineText) : undefined });
      default:
        return { ok: false, message: `Unsupported action: ${name}.` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function planStandupDigest(userId: string): Promise<AutomationProposal[]> {
  const repos = await getRepos(userId).catch(() => []);
  if (repos.length === 0) return [];
  const r = repos[0];
  return [{
    title: `Generate standup for ${r.fullName}`,
    entityType: "github_repo",
    entityId: String(r.id),
    tool: "generate_standup",
    args: { repo: r.fullName },
  }];
}

export const pmVertical: PersonaVertical = {
  persona: PERSONA,
  tools: TOOLS,
  systemPrompt: SYSTEM_PROMPT,
  buildSnapshot,
  executeTool,
  summarizeAction,
  // No seedDemo — PM works over live connected-app data.
  automations: [
    {
      type: "standup_digest",
      title: "Daily standup digest",
      description: "Summarize open PRs + issues for your top repo",
      cadenceDays: 1,
      defaultAutonomy: "suggest",
      plan: planStandupDigest,
    },
  ],
};
