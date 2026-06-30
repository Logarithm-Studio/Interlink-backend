/**
 * Product Manager workflow automations.
 *
 * 1. Standup Summary — daily digest of PRs merged + issues closed.
 * 2. Sprint Planning — Gemini estimates + prioritizes a list of issues.
 * 3. PR Review Alerts — identify stale open PRs.
 */

import { geminiGenerateContent } from "../ai/geminiClient";
import { getRepos, getPullRequests, getIssues } from "./github.service";
import { getCardsForBoard, getBoards } from "./trello.service";
import { AppUser } from "../../types";

// ─── Standup Summary ─────────────────────────────────────────────────────────

export interface StandupSummary {
  date: string;
  openPRs: number;
  stalePRs: { title: string; author: string; daysOld: number; url: string }[];
  openIssues: number;
  highPriorityIssues: { title: string; url: string }[];
  summary: string;
  isFallback: boolean;
}

export async function generateStandupSummary(
  userId: string,
  owner: string,
  repo: string,
): Promise<StandupSummary> {
  const [prs, issues] = await Promise.all([
    getPullRequests(userId, owner, repo),
    getIssues(userId, owner, repo),
  ]);

  const now = Date.now();
  const stalePRs = prs
    .filter((pr) => (now - new Date(pr.createdAt).getTime()) > 2 * 24 * 60 * 60 * 1000)
    .map((pr) => ({
      title: pr.title,
      author: pr.author,
      daysOld: Math.floor((now - new Date(pr.createdAt).getTime()) / 86_400_000),
      url: pr.htmlUrl,
    }));

  const highPriority = issues
    .filter((i) => i.labels.some((l) => l.toLowerCase().includes("priority") || l.toLowerCase().includes("bug")))
    .map((i) => ({ title: i.title, url: i.htmlUrl }));

  const snapshot = [
    `Open PRs: ${prs.length} (${stalePRs.length} stale >2d)`,
    `Open Issues: ${issues.length} (${highPriority.length} high-priority)`,
    stalePRs.length > 0 ? `Stale PRs:\n${stalePRs.map((p) => `- ${p.title} by ${p.author} (${p.daysOld}d)`).join("\n")}` : "",
    highPriority.length > 0 ? `High-priority issues:\n${highPriority.map((i) => `- ${i.title}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");

  let summary = `You have ${prs.length} open PRs and ${issues.length} open issues. ${stalePRs.length > 0 ? `${stalePRs.length} PRs need attention.` : ""}`;
  let isFallback = true;

  try {
    const result = await geminiGenerateContent({
      system: "You are a product manager's AI assistant. Write a concise daily standup summary (3-5 sentences max). Focus on what needs attention today. Return JSON: { summary: string }",
      parts: [{ text: snapshot }],
      json: true,
      responseSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    });
    const parsed = JSON.parse(result.raw) as { summary?: string };
    if (parsed.summary) { summary = parsed.summary; isFallback = false; }
  } catch { /* use fallback */ }

  return {
    date: new Date().toISOString().split("T")[0],
    openPRs: prs.length,
    stalePRs,
    openIssues: issues.length,
    highPriorityIssues: highPriority,
    summary,
    isFallback,
  };
}

// ─── Sprint Planning ──────────────────────────────────────────────────────────

export interface SprintPlan {
  issues: { title: string; url: string; estimate: string; priority: "high" | "medium" | "low" }[];
  summary: string;
  isFallback: boolean;
}

export async function planSprint(
  userId: string,
  owner: string,
  repo: string,
): Promise<SprintPlan> {
  const issues = (await getIssues(userId, owner, repo)).slice(0, 20);

  if (issues.length === 0) {
    return { issues: [], summary: "No open issues found.", isFallback: true };
  }

  const issueList = issues.map((i) => `- ${i.title} [labels: ${i.labels.join(", ") || "none"}]`).join("\n");

  let plan: SprintPlan = {
    issues: issues.slice(0, 10).map((i) => ({ title: i.title, url: i.htmlUrl, estimate: "1-2d", priority: "medium" as const })),
    summary: `${issues.length} issues available for the sprint.`,
    isFallback: true,
  };

  try {
    const result = await geminiGenerateContent({
      system: `You are a product manager. Prioritize these issues for the next sprint and estimate effort.
Return JSON: { issues: [{ title: string, priority: "high"|"medium"|"low", estimate: string }], summary: string }`,
      parts: [{ text: issueList }],
      json: true,
      maxOutputTokens: 2048,
    });
    const parsed = JSON.parse(result.raw) as {
      issues?: { title: string; priority: string; estimate: string }[];
      summary?: string;
    };
    if (parsed.issues) {
      plan = {
        issues: issues
          .map((issue) => {
            const match = parsed.issues?.find((p) => issue.title.toLowerCase().includes(p.title.toLowerCase().slice(0, 20)));
            return {
              title: issue.title,
              url: issue.htmlUrl,
              estimate: match?.estimate ?? "1-2d",
              priority: ((match?.priority as "high" | "medium" | "low") ?? "medium"),
            };
          }),
        summary: parsed.summary ?? plan.summary,
        isFallback: false,
      };
    }
  } catch { /* use fallback */ }

  return plan;
}

// ─── Trello Board Summary ─────────────────────────────────────────────────────

export interface TrelloBoardSummary {
  boardName: string;
  totalCards: number;
  overdueCards: { name: string; url: string; daysOverdue: number }[];
  summary: string;
}

export async function getTrelloBoardSummary(userId: string): Promise<TrelloBoardSummary[]> {
  const boards = await getBoards(userId);
  const summaries: TrelloBoardSummary[] = [];

  for (const board of boards.slice(0, 3)) {
    const cards = await getCardsForBoard(userId, board.id);
    const now = Date.now();
    const overdue = cards
      .filter((c) => c.due && !c.dueComplete && new Date(c.due).getTime() < now)
      .map((c) => ({
        name: c.name,
        url: c.url,
        daysOverdue: Math.floor((now - new Date(c.due!).getTime()) / 86_400_000),
      }));
    summaries.push({
      boardName: board.name,
      totalCards: cards.length,
      overdueCards: overdue,
      summary: `${cards.length} open cards, ${overdue.length} overdue.`,
    });
  }
  return summaries;
}
