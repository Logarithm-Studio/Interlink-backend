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
import { getRepos, getPullRequests, getIssues, createIssue, getRecentCommits, getMergedPullRequests } from "../../pm/github.service";
import { getProjects as getJiraProjects, searchIssues as searchJiraIssues } from "../../jira/jira.service";
import { searchPages as searchNotionPages } from "../../notion/notion.service";
import { getChannels as getSlackChannels } from "../../slack/slack.service";
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
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(full ?? "").trim())) return null;
  const [owner, repo] = String(full ?? "").split("/");
  return owner && repo ? { owner, repo } : null;
}

async function buildSnapshot(userId: string): Promise<string> {
  const conns = await pmConnections(userId);
  const lines = [connectionsLine(conns)];
  const read = async <T,>(label: string, source: Promise<T[]>): Promise<T[]> => {
    try { return await source; }
    catch { lines.push(`${label} is unavailable: lookup failed. Do not treat this as an empty source.`); return []; }
  };

  // Ground the agent in ALL connected apps it orchestrates (not just GitHub), so it
  // can resolve repos/projects/pages/channels itself instead of asking for IDs.
  if (conns.github) {
    const repos = await read("GitHub repositories", getRepos(userId));
    if (repos.length > 0) {
      lines.push(
        `GitHub repos: ${repos.length}.`,
        "Repos (name | open issues | language):",
        ...repos.slice(0, 15).map((r) => `- ${r.fullName} | ${r.openIssues} open | ${r.language ?? "—"}`),
      );
      // Contribution tracking: recent commits + merged PRs on the most-active repo,
      // so the agent can report "what's shipped" without being asked for a repo.
      const top = repos[0];
      const [owner, name] = top.fullName.split("/");
      if (owner && name) {
        const [commits, merged] = await Promise.all([
          read("GitHub commits", getRecentCommits(userId, owner, name, 8)),
          read("GitHub merged PRs", getMergedPullRequests(userId, owner, name)),
        ]);
        if (commits.length > 0) {
          lines.push(
            `Recent commits on ${top.fullName}:`,
            ...commits.slice(0, 8).map((c) => `- ${c.sha} ${c.message}${c.author ? ` (${c.author})` : ""}`),
          );
        }
        if (merged.length > 0) {
          lines.push(
            `Recently merged PRs on ${top.fullName}:`,
            ...merged.slice(0, 5).map((p) => `- #${p.number} ${p.title} (${p.author})`),
          );
        }
      }
    } else {
      lines.push("No repository rows are available in this snapshot; check the source status above.");
    }
  }
  if (conns.jira) {
    const projects = await read("Jira projects", getJiraProjects(userId));
    if (projects.length > 0) {
      lines.push(`Jira projects: ${projects.slice(0, 12).map((p) => `${p.key} (${p.name})`).join(", ")}.`);
    }
    // Jira updates auto-synced: recently touched issues (last 7 days), newest first.
    const recent = await read("Jira updates", searchJiraIssues(userId, "updated >= -7d ORDER BY updated DESC"));
    if (recent.length > 0) {
      lines.push(
        "Recent Jira updates (last 7 days):",
        ...recent.slice(0, 8).map((i) => `- ${i.key} ${i.summary} | ${i.status}${i.assignee ? ` | ${i.assignee}` : ""}`),
      );
    }
  }
  if (conns.notion) {
    const pages = await read("Notion pages", searchNotionPages(userId, ""));
    if (pages.length > 0) {
      lines.push(`Notion pages: ${pages.slice(0, 12).map((p) => p.title).join(", ")}.`);
    }
  }
  if (conns.slack) {
    const channels = await read("Slack channels", getSlackChannels(userId));
    if (channels.length > 0) {
      lines.push(`Slack channels: ${channels.slice(0, 15).map((c) => `#${c.name} (${c.id})`).join(", ")}.`);
    }
  }
  if (!conns.github && !conns.jira && !conns.notion && !conns.slack) {
    lines.push("Drafting from supplied briefs is available. Connect GitHub, Jira, Notion or Slack in Settings for source reads and separately reviewed delivery.");
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT = [
  "You are the user's AI product-manager assistant inside the Interlink app.",
  "You work across the user's connected apps — GitHub, Jira, Notion, and Slack (see DATA SNAPSHOT",
  "for what's connected). Answer questions, or perform ONE action by calling a function when asked.",
  "The snapshot AUTO-SYNCS recent GitHub commits + merged PRs and recently-updated Jira issues, so you can",
  "answer 'what shipped / what changed / how are contributions tracking' directly from it; contribution_summary",
  "compiles a fuller report on demand.",
  "Key workflows: prepare exact stories from a Notion/supplied PRD (prd_to_tickets); prepare a critical defect brief and",
  "observed workload (sprint_interruption); draft release notes from merged GitHub PRs (release_notes);",
  "compile a cross-functional status update (status_sync); check a client request for scope creep and",
  "draft a change order (scope_creep_check). Use exact repo full-names (owner/name) from the snapshot.",
  "Preparation tools never create tickets, assign people or publish. If the ORIGINAL request asks for delivery, continue using the exact returned drafts with separately reviewed create_jira_issue, assign_jira_issue, create_notion_note or post_slack_message actions. A connection alone never authorizes an export. Resolve project, assignee and channel IDs; ask if ambiguous. Linear can be used when the user selected it and it is connected.",
  "You never write anything yourself — the app confirms before executing.",
].join("\n");

const TOOLS: GeminiToolFunction[] = [
  { name: "create_issue", description: "Create a GitHub issue in a repo.", parameters: { type: "object", properties: { repo: { type: "string", description: "owner/name from the snapshot." }, title: { type: "string" }, body: { type: "string" } }, required: ["repo", "title"] } },
  { name: "summarize_prs", description: "Summarize open pull requests for a GitHub repo.", parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
  { name: "generate_standup", description: "Generate a standup summary (open PRs + issues) for a GitHub repo.", parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
  { name: "contribution_summary", description: "Compile a contribution/activity report for a repo: recent commits, merged + open PRs, and recently updated Jira issues. Use for 'what shipped', 'track contributions', 'what changed'.", parameters: { type: "object", properties: { repo: { type: "string", description: "owner/name; defaults to the top repo in the snapshot." } } } },
  { name: "prd_to_tickets", description: "Prepare draft user stories from exact Notion PRD or supplied prdText (including text extracted from an attachment). Never creates tickets. Review each returned story separately with create_jira_issue if creation was requested.", parameters: { type: "object", properties: { notionPageQuery: { type: "string" }, notionPageId: { type: "string" }, prdText: { type: "string" }, projectKey: { type: "string", description: "Exact selected Jira project key; ambiguous projects require a choice." } } } },
  { name: "sprint_interruption", description: "Prepare an exact defect brief and observed workload. No tickets, assignment or alerts are created. Use separate reviewed writes for requested follow-up.", parameters: { type: "object", properties: { defect: { type: "string" }, slackChannel: { type: "string" }, alertChannel: { type: "string" }, projectKey: { type: "string" } } } },
  { name: "release_notes", description: "Prepare release-note copy from merged PRs only. Never publishes. Publication needs separate exact-content/destination review only when requested.", parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
  { name: "status_sync", description: "Read GitHub/Jira signals and compile source-labelled status. Lookup failure is an error, never zero issues. Never saves or publishes.", parameters: { type: "object", properties: { repo: { type: "string" } } } },
  { name: "scope_creep_check", description: "Compare a client feature-amendment against the baseline scope (Notion) and draft a change-order notice.", parameters: { type: "object", properties: { amendmentText: { type: "string" }, baselineQuery: { type: "string", description: "Title of the baseline scoping doc in Notion." }, baselinePageId: { type: "string" }, baselineText: { type: "string" } }, required: ["amendmentText"] } },
];

function summarizeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "create_issue": return `Create issue "${args.title ?? ""}" in ${args.repo ?? "repo"}.`;
    case "summarize_prs": return `Summarize open PRs in ${args.repo ?? "repo"}.`;
    case "generate_standup": return `Generate a standup for ${args.repo ?? "repo"}.`;
    case "contribution_summary": return `Compile a contribution report${args.repo ? ` for ${args.repo}` : ""}.`;
    case "prd_to_tickets": return "Prepare exact ticket drafts. No tickets will be created.";
    case "sprint_interruption": return "Prepare the defect brief. No ticket, assignment or alert.";
    case "release_notes": return `Prepare release notes for ${args.repo ?? "repo"}. Nothing will be published.`;
    case "status_sync": return "Read source signals and compile a status draft. Nothing will be published.";
    case "scope_creep_check": return `Check the client request for scope creep and draft a change order.`;
    default: return `Run ${name}.`;
  }
}

async function executeTool(user: AppUser, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string; data?: unknown }> {
  try {
    switch (name) {
      // ─── GitHub basics ──────────────────────────────────────────────────────
      case "create_issue": {
        const parts = splitRepo(String(args.repo ?? ""));
        if (!parts) return { ok: false, message: "Please specify the repo as owner/name." };
        const issue = await createIssue(user.id, parts.owner, parts.repo, { title: String(args.title ?? "").trim(), body: args.body ? String(args.body) : undefined });
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "issue_created", title: `Opened #${issue.number} in ${args.repo}`, detail: issue.title, entityType: "github_issue", entityId: String(issue.number) });
        return { ok: true, message: `Created issue #${issue.number}: ${issue.title}.`, data: issue };
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
        return { ok: true, message: `Standup — ${args.repo}\nOpen PRs: ${prs.length}\n` + prs.slice(0, 8).map((p) => `- #${p.number} ${p.title}`).join("\n") + `\nOpen issues: ${issues.length}\n` + issues.slice(0, 8).map((i) => `- #${i.number} ${i.title}`).join("\n") };
      }
      case "contribution_summary": {
        let repoFull = String(args.repo ?? "").trim();
        if (!repoFull) {
          const repos = await getRepos(user.id);
          if (repos.length !== 1) return { ok: false, message: "Choose the exact repository for this contribution report." };
          repoFull = repos[0].fullName;
        }
        const parts = splitRepo(repoFull);
        if (!parts) return { ok: false, message: "Connect GitHub (and specify a repo as owner/name) to track contributions." };
        const jiraConnected = (await pmConnections(user.id)).jira;
        const [commits, merged, openPrs, jira] = await Promise.all([
          getRecentCommits(user.id, parts.owner, parts.repo, 12),
          getMergedPullRequests(user.id, parts.owner, parts.repo),
          getPullRequests(user.id, parts.owner, parts.repo),
          jiraConnected ? searchJiraIssues(user.id, "updated >= -7d ORDER BY updated DESC") : Promise.resolve([]),
        ]);
        const section = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items] : []);
        const body = [
          `Contribution report — ${repoFull}`,
          ...section("Recent commits", commits.slice(0, 10).map((c) => `- ${c.sha} ${c.message}${c.author ? ` (${c.author})` : ""}`)),
          ...section("Merged PRs", merged.slice(0, 8).map((p) => `- #${p.number} ${p.title} (${p.author})`)),
          ...section("Open PRs", openPrs.slice(0, 8).map((p) => `- #${p.number} ${p.title} (${p.author})`)),
          ...section("Jira updates (7d)", jira.slice(0, 8).map((i) => `- ${i.key} ${i.summary} | ${i.status}`)),
        ].join("\n");
        await recordActivity({ userId: user.id, persona: PERSONA, kind: "contribution_summary", title: `Contribution report for ${repoFull}` });
        return { ok: true, message: body || "No recent activity found." };
      }
      // ─── PRD workflows (multi-app) ──────────────────────────────────────────
      case "prd_to_tickets":
        return await prdToTickets(user, { notionPageId: args.notionPageId ? String(args.notionPageId) : undefined, notionPageQuery: args.notionPageQuery ? String(args.notionPageQuery) : undefined, projectKey: args.projectKey ? String(args.projectKey) : undefined, prdText: args.prdText ? String(args.prdText) : undefined });
      case "sprint_interruption":
        return await sprintInterruption(user, { defect: args.defect ? String(args.defect) : undefined, slackChannel: args.slackChannel ? String(args.slackChannel) : undefined, alertChannel: args.alertChannel ? String(args.alertChannel) : undefined, projectKey: args.projectKey ? String(args.projectKey) : undefined });
      case "release_notes":
        return await releaseNotes(user, { repo: args.repo ? String(args.repo) : undefined });
      case "status_sync":
        return await statusSync(user, { repo: args.repo ? String(args.repo) : undefined });
      case "scope_creep_check":
        return await scopeCreepCheck(user, { amendmentText: args.amendmentText ? String(args.amendmentText) : undefined, baselinePageId: args.baselinePageId ? String(args.baselinePageId) : undefined, baselineQuery: args.baselineQuery ? String(args.baselineQuery) : undefined, baselineText: args.baselineText ? String(args.baselineText) : undefined });
      default:
        return { ok: false, message: `Unsupported action: ${name}.` };
    }
  } catch (err) {
    return { ok: false, message: `PM source/action failed: ${err instanceof Error ? err.message : String(err)}` };
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
  readOnlyTools: ["summarize_prs", "generate_standup", "contribution_summary", "prd_to_tickets", "sprint_interruption", "release_notes", "status_sync", "scope_creep_check"],
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
