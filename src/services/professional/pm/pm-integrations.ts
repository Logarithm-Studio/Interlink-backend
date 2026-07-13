/**
 * Product-Manager PRD workflows that span the user's connected apps.
 *
 * Every function is gated on the relevant integration being connected and
 * degrades to a friendly "connect X" message otherwise (mirrors the PM vertical
 * pattern). Apps named in the PRD that Interlink can't connect yet are mapped to
 * the closest connected one: Linear→Jira, Teams→Slack, Intercom/Slides→Notion/Slack.
 */

import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { isConnected } from "../../integrations/tokenStore";
import { geminiGenerateContent, isGeminiLive } from "../../ai/geminiClient";
import { draftEmail } from "../draft";
import {
  getProjects,
  searchIssues,
  createIssue as createJiraIssue,
  deleteIssue as deleteJiraIssue,
} from "../../jira/jira.service";
import { runSaga, sagaStep, SagaError, describeSagaFailure } from "../../workflow/saga";
import {
  searchPages,
  getPageContent,
  createPage as createNotionPage,
} from "../../notion/notion.service";
import { getChannels, postMessage, getRecentMessages } from "../../slack/slack.service";
import { getPullRequests, getMergedPullRequests, getIssues } from "../../pm/github.service";

const PERSONA = "product_manager";

export type PmResult = { ok: boolean; message: string };

// ─── Connection status (for the snapshot + dashboard overview) ─────────────────

export interface PmConnections {
  github: boolean;
  jira: boolean;
  notion: boolean;
  slack: boolean;
  trello: boolean;
}

export async function pmConnections(userId: string): Promise<PmConnections> {
  const [github, jira, notion, slack, trello] = await Promise.all([
    isConnected(userId, "github"),
    isConnected(userId, "jira"),
    isConnected(userId, "notion"),
    isConnected(userId, "slack"),
    isConnected(userId, "trello"),
  ]);
  return { github, jira, notion, slack, trello };
}

export function connectionsLine(c: PmConnections): string {
  const mark = (b: boolean) => (b ? "✓" : "✗");
  return `Connected apps — GitHub ${mark(c.github)} · Jira ${mark(c.jira)} · Notion ${mark(c.notion)} · Slack ${mark(c.slack)} · Trello ${mark(c.trello)}.`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function splitRepo(full: string): { owner: string; repo: string } | null {
  const [owner, repo] = String(full ?? "").split("/");
  return owner && repo ? { owner, repo } : null;
}

/** Resolve a Notion page by id or fuzzy title. */
async function resolveNotionPage(
  userId: string,
  ref: { id?: string; query?: string },
): Promise<{ id: string; title: string } | null> {
  if (ref.id) return { id: ref.id, title: ref.query ?? "page" };
  const q = (ref.query ?? "").trim();
  const pages = await searchPages(userId, q);
  if (pages.length === 0) return null;
  const lower = q.toLowerCase();
  const match =
    pages.find((p) => p.title.toLowerCase() === lower) ??
    pages.find((p) => p.title.toLowerCase().includes(lower)) ??
    pages[0];
  return { id: match.id, title: match.title };
}

/** A page to nest new content under — the preferred id, else the first shared page. */
async function resolveNotionParent(userId: string, preferredId?: string): Promise<string | null> {
  if (preferredId) return preferredId;
  const pages = await searchPages(userId, "");
  return pages[0]?.id ?? null;
}

async function firstProjectKey(userId: string, provided?: string): Promise<string | null> {
  if (provided?.trim()) return provided.trim();
  const projects = await getProjects(userId);
  return projects[0]?.key ?? null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// ─── PRD #1 — PRD → Jira tickets ────────────────────────────────────────────────

export async function prdToTickets(
  user: AppUser,
  args: { notionPageId?: string; notionPageQuery?: string; projectKey?: string },
): Promise<PmResult> {
  if (!(await isConnected(user.id, "notion"))) return { ok: false, message: "Connect Notion in Settings → Manage Integrations to read your PRD." };
  if (!(await isConnected(user.id, "jira"))) return { ok: false, message: "Connect Jira in Settings → Manage Integrations to create tickets." };
  if (!isGeminiLive()) return { ok: false, message: "The AI model is offline, so I can't deconstruct the PRD right now." };

  const page = await resolveNotionPage(user.id, { id: args.notionPageId, query: args.notionPageQuery });
  if (!page) return { ok: false, message: "Couldn't find that PRD page. Share the page with the Interlink integration in Notion." };

  const content = await getPageContent(user.id, page.id);
  if (!content.trim()) return { ok: false, message: `"${page.title}" looks empty or isn't shared with the integration.` };

  const projectKey = await firstProjectKey(user.id, args.projectKey);
  if (!projectKey) return { ok: false, message: "No Jira project is available. Create one, then try again." };

  let stories: { summary: string; description: string }[] = [];
  try {
    const result = await geminiGenerateContent({
      system:
        "You are a senior product manager. Read this PRD and break it into implementable user stories. " +
        'Return ONLY JSON: {"stories":[{"summary":string,"description":string}]}. ' +
        "Each summary is a concise ticket title; each description includes the functional rule + technical scope/acceptance criteria. Max 12 stories.",
      parts: [{ text: content.slice(0, 16000) }],
      json: true,
      maxOutputTokens: 4096,
    });
    const o = JSON.parse(result.raw) as { stories?: { summary?: unknown; description?: unknown }[] };
    stories = (o.stories ?? [])
      .map((s) => ({ summary: str(s.summary).trim(), description: str(s.description).trim() }))
      .filter((s) => s.summary)
      .slice(0, 12);
  } catch {
    return { ok: false, message: "Couldn't parse the PRD into stories. Try again or simplify the document." };
  }
  if (stories.length === 0) return { ok: false, message: "No user stories could be extracted from that PRD." };

  // TRANSACTION BOUNDARY: creating N tickets is one logical action. Previously a failure
  // partway through left the already-created tickets orphaned in Jira. Now it's atomic —
  // if any ticket fails, every ticket created in this run is rolled back.
  const created: string[] = [];
  try {
    await runSaga(
      "prd_to_tickets",
      stories.map((s) =>
        sagaStep<string>({
          key: `jira:create:${s.summary.slice(0, 40)}`,
          run: async () => {
            const issue = await createJiraIssue(user.id, {
              projectKey,
              summary: s.summary,
              description: s.description,
              issueType: "Story",
            });
            const key = issue.key || s.summary;
            created.push(key);
            return key;
          },
          undo: async (key) => {
            await deleteJiraIssue(user.id, key);
            const i = created.indexOf(key);
            if (i >= 0) created.splice(i, 1);
          },
        }),
      ),
    );
  } catch (err) {
    if (err instanceof SagaError) return { ok: false, message: describeSagaFailure(err) };
    return { ok: false, message: "Jira rejected the tickets. Check the project key and permissions." };
  }
  if (created.length === 0) return { ok: false, message: "Jira rejected the tickets. Check the project key and permissions." };

  await recordActivity({
    userId: user.id, persona: PERSONA, kind: "prd_to_tickets",
    title: `Created ${created.length} Jira ticket(s) from "${page.title}"`,
    detail: created.slice(0, 6).join(", "), entityType: "jira_project", entityId: projectKey,
  });
  return { ok: true, message: `Deconstructed "${page.title}" into ${created.length} Jira ticket(s) in ${projectKey}: ${created.slice(0, 8).join(", ")}${created.length > 8 ? "…" : ""}.` };
}

// ─── PRD #2 — Sprint interruption warning ───────────────────────────────────────

export async function sprintInterruption(
  user: AppUser,
  args: { defect?: string; slackChannel?: string; alertChannel?: string; projectKey?: string },
): Promise<PmResult> {
  if (!(await isConnected(user.id, "jira"))) return { ok: false, message: "Connect Jira in Settings → Manage Integrations to log the defect and check workloads." };
  if (!(await isConnected(user.id, "slack"))) return { ok: false, message: "Connect Slack in Settings → Manage Integrations to alert the team." };

  // Source the defect from a pasted message or from the flagged Slack channel.
  let defect = (args.defect ?? "").trim();
  if (!defect && args.slackChannel) {
    const msgs = await getRecentMessages(user.id, args.slackChannel, 25).catch(() => []);
    const critical = msgs.find((m) => /\b(critical|urgent|p0|sev-?1|outage|bug|broken|error)\b/i.test(m));
    defect = (critical ?? msgs[0] ?? "").trim();
  }
  if (!defect) return { ok: false, message: "Paste the defect details (or pass the bug channel) so I can log and route it." };

  // Weigh developer workloads from unresolved issues.
  const open = await searchIssues(user.id, "resolution = Unresolved ORDER BY updated DESC").catch(() => []);
  const load = new Map<string, number>();
  for (const i of open) {
    const who = i.assignee ?? "Unassigned";
    load.set(who, (load.get(who) ?? 0) + 1);
  }
  const assignees = [...load.entries()].filter(([who]) => who !== "Unassigned");
  const leastLoaded = assignees.sort((a, b) => a[1] - b[1])[0]?.[0] ?? "the on-call engineer";
  const workloadSummary = assignees.length
    ? assignees.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([who, n]) => `${who}: ${n}`).join(", ")
    : "no open assignments found";

  const projectKey = await firstProjectKey(user.id, args.projectKey);
  if (!projectKey) return { ok: false, message: "No Jira project is available to log the defect." };

  const summary = `[Critical] ${defect.split("\n")[0].slice(0, 120)}`;
  const description = `Flagged critical defect:\n${defect}\n\nCurrent developer workloads: ${workloadSummary}.\nSuggested owner (least-loaded): ${leastLoaded}.`;
  const alertChannel = args.alertChannel ?? args.slackChannel;

  // TRANSACTION BOUNDARY (see services/workflow/saga.ts): creating the Jira ticket and
  // alerting Slack is a multi-app write. If the Slack alert fails AFTER the ticket is
  // created, the ticket is deleted so we never leave orphaned/partial state behind.
  let ticketKey = "";
  try {
    await runSaga("sprint_interruption", [
      sagaStep<string>({
        key: "jira:create-issue",
        run: async () => {
          const issue = await createJiraIssue(user.id, { projectKey, summary, description, issueType: "Bug" });
          ticketKey = issue.key;
          return issue.key;
        },
        undo: async (key) => {
          await deleteJiraIssue(user.id, key);
          ticketKey = "";
        },
      }),
      ...(alertChannel
        ? [
            sagaStep<void>({
              key: "slack:alert-team",
              run: async () => {
                await postMessage(
                  user.id,
                  alertChannel,
                  `🚨 *Critical defect logged* — ${ticketKey}\n${summary}\nSuggested owner: *${leastLoaded}* (lightest load). Workloads — ${workloadSummary}.`,
                );
              },
            }),
          ]
        : []),
    ]);
  } catch (err) {
    if (err instanceof SagaError) return { ok: false, message: describeSagaFailure(err) };
    return { ok: false, message: "Couldn't create the Jira bug ticket. Check the project key and permissions." };
  }

  if (!alertChannel) return { ok: true, message: `Logged ${ticketKey} for the defect. Tell me a Slack channel to alert the team.` };

  await recordActivity({
    userId: user.id, persona: PERSONA, kind: "sprint_interruption",
    title: `Logged & alerted critical defect ${ticketKey}`, detail: `Suggested owner: ${leastLoaded}`,
    entityType: "jira_issue", entityId: ticketKey,
  });
  return { ok: true, message: `Logged ${ticketKey}, suggested *${leastLoaded}* as owner, and alerted the team on Slack.` };
}

// ─── PRD #3 — Release note generation ───────────────────────────────────────────

export async function releaseNotes(
  user: AppUser,
  args: { repo?: string; notionParentId?: string; slackChannel?: string },
): Promise<PmResult> {
  if (!(await isConnected(user.id, "github"))) return { ok: false, message: "Connect GitHub in Settings → Manage Integrations to read merged pull requests." };
  const parts = splitRepo(str(args.repo));
  if (!parts) return { ok: false, message: "Tell me which repo (owner/name) to draft release notes for." };

  const prs = await getMergedPullRequests(user.id, parts.owner, parts.repo);
  if (prs.length === 0) return { ok: false, message: "No recently merged pull requests found to summarize." };

  const draft = await draftEmail({
    role: "release manager",
    purpose: "concise consumer-facing release notes grouped by theme (put the notes in the body field)",
    context: `Repo ${args.repo}. Merged pull requests:\n` + prs.slice(0, 30).map((p) => `- ${p.title}`).join("\n"),
  });
  const title = `Release Notes — ${args.repo} — ${new Date().toISOString().split("T")[0]}`;

  const published: string[] = [];
  if (await isConnected(user.id, "notion")) {
    const parent = await resolveNotionParent(user.id, args.notionParentId);
    if (parent) {
      try {
        const page = await createNotionPage(user.id, { parentId: parent, title, content: draft.body });
        published.push(page.url ? `Notion (${page.url})` : "Notion");
      } catch { /* keep going */ }
    }
  }
  if (args.slackChannel && (await isConnected(user.id, "slack"))) {
    try {
      await postMessage(user.id, args.slackChannel, `*${title}*\n${draft.body}`);
      published.push("Slack");
    } catch { /* keep going */ }
  }

  await recordActivity({
    userId: user.id, persona: PERSONA, kind: "release_notes",
    title: `Drafted release notes for ${args.repo}`, detail: published.length ? `Published to ${published.join(" + ")}` : "draft only",
    entityType: "github_repo", entityId: str(args.repo),
  });
  const where = published.length ? ` Published to ${published.join(" + ")}.` : " Connect Notion or pass a Slack channel to publish it.";
  return { ok: true, message: `${title}\n\n${draft.body}\n\n—${where}` };
}

// ─── PRD #4 — Cross-functional status sync ──────────────────────────────────────

export async function statusSync(
  user: AppUser,
  args: { repo?: string; notionParentId?: string; slackChannel?: string },
): Promise<PmResult> {
  const lines: string[] = [];
  const parts = splitRepo(str(args.repo));
  if (parts && (await isConnected(user.id, "github"))) {
    const [prs, issues] = await Promise.all([
      getPullRequests(user.id, parts.owner, parts.repo).catch(() => []),
      getIssues(user.id, parts.owner, parts.repo).catch(() => []),
    ]);
    lines.push(`GitHub (${args.repo}): ${prs.length} open PRs, ${issues.length} open issues.`);
    lines.push(...prs.slice(0, 8).map((p) => `- PR #${p.number} ${p.title}`));
  }
  if (await isConnected(user.id, "jira")) {
    const jira = await searchIssues(user.id, "resolution = Unresolved ORDER BY updated DESC").catch(() => []);
    lines.push(`Jira: ${jira.length} unresolved issues.`);
    lines.push(...jira.slice(0, 8).map((i) => `- ${i.key} ${i.summary} [${i.status}]`));
  }
  if (lines.length === 0) return { ok: false, message: "Connect GitHub and/or Jira (and pass a repo) so I can compile a status update." };

  const raw = lines.join("\n");
  let summary = raw;
  if (isGeminiLive()) {
    try {
      const result = await geminiGenerateContent({
        system:
          "You are a product manager. Write a crisp cross-functional status update (5-8 sentences) from these engineering signals, highlighting progress, risks, and what needs attention. " +
          'Return ONLY JSON: {"summary":string}.',
        parts: [{ text: raw }],
        json: true,
        maxOutputTokens: 1024,
      });
      const o = JSON.parse(result.raw) as { summary?: unknown };
      if (typeof o.summary === "string" && o.summary.trim()) summary = o.summary.trim();
    } catch { /* fall back to raw */ }
  }

  const title = `Status Update — ${new Date().toISOString().split("T")[0]}`;
  const published: string[] = [];
  if (await isConnected(user.id, "notion")) {
    const parent = await resolveNotionParent(user.id, args.notionParentId);
    if (parent) {
      try {
        const page = await createNotionPage(user.id, { parentId: parent, title, content: summary });
        published.push(page.url ? `Notion (${page.url})` : "Notion");
      } catch { /* keep going */ }
    }
  }
  if (args.slackChannel && (await isConnected(user.id, "slack"))) {
    try {
      await postMessage(user.id, args.slackChannel, `*${title}*\n${summary}`);
      published.push("Slack");
    } catch { /* keep going */ }
  }

  await recordActivity({
    userId: user.id, persona: PERSONA, kind: "status_sync",
    title: "Compiled cross-functional status update", detail: published.length ? `Published to ${published.join(" + ")}` : "summary only",
  });
  const where = published.length ? ` Published to ${published.join(" + ")}.` : " Connect Notion or pass a Slack channel to publish it.";
  return { ok: true, message: `${title}\n\n${summary}\n\n—${where}` };
}

// ─── PRD #5 — Scope creep protection ────────────────────────────────────────────

export async function scopeCreepCheck(
  user: AppUser,
  args: { amendmentText?: string; baselinePageId?: string; baselineQuery?: string; baselineText?: string },
): Promise<PmResult> {
  const amendment = (args.amendmentText ?? "").trim();
  if (!amendment) return { ok: false, message: "Paste the client's feature-amendment request so I can check it against the baseline scope." };

  let baseline = (args.baselineText ?? "").trim();
  if (!baseline) {
    if (!(await isConnected(user.id, "notion"))) return { ok: false, message: "Connect Notion (or paste the baseline scope) so I can compare against the original scoping document." };
    const page = await resolveNotionPage(user.id, { id: args.baselinePageId, query: args.baselineQuery });
    if (!page) return { ok: false, message: "Couldn't find the baseline scoping document in Notion." };
    baseline = await getPageContent(user.id, page.id);
    if (!baseline.trim()) return { ok: false, message: "The baseline scoping document looks empty or isn't shared with the integration." };
  }

  let analysis = "";
  if (isGeminiLive()) {
    try {
      const result = await geminiGenerateContent({
        system:
          "You are a product manager protecting project scope. Compare the CLIENT AMENDMENT against the BASELINE SCOPE. " +
          'Return ONLY JSON: {"outOfScope":string[],"estimatedExtraDays":number,"summary":string}. ' +
          "List concrete out-of-scope items, a rough extra-effort estimate in engineer-days, and a one-paragraph summary.",
        parts: [{ text: `BASELINE SCOPE:\n${baseline.slice(0, 8000)}\n\nCLIENT AMENDMENT:\n${amendment.slice(0, 6000)}` }],
        json: true,
        maxOutputTokens: 1500,
      });
      const o = JSON.parse(result.raw) as { outOfScope?: unknown[]; estimatedExtraDays?: unknown; summary?: unknown };
      const items = Array.isArray(o.outOfScope) ? o.outOfScope.map(str).filter(Boolean) : [];
      const days = typeof o.estimatedExtraDays === "number" ? o.estimatedExtraDays : undefined;
      analysis = [
        str(o.summary),
        items.length ? `Out of scope: ${items.join("; ")}.` : "",
        days != null ? `Estimated extra effort: ~${days} engineer-day(s).` : "",
      ].filter(Boolean).join(" ");
    } catch { /* fall through */ }
  }
  if (!analysis) analysis = "The amendment introduces work beyond the agreed baseline scope and will require additional effort to deliver.";

  const draft = await draftEmail({
    role: "product manager",
    purpose: "a professional change-order notice that acknowledges the request, explains it exceeds the agreed scope, and proposes a change order with the extra effort/cost (put the notice in the body field)",
    context: `Scope-creep analysis: ${analysis}\n\nClient request: ${amendment.slice(0, 2000)}`,
  });

  await recordActivity({
    userId: user.id, persona: PERSONA, kind: "scope_creep_check",
    title: "Flagged scope creep & drafted a change order", detail: analysis.slice(0, 120),
  });
  return { ok: true, message: `Scope check:\n${analysis}\n\n— Draft change-order notice —\nSubject: ${draft.subject}\n\n${draft.body}` };
}
