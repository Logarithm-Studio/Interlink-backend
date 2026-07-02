/**
 * Normalized per-persona dashboard payload so the app can render every
 * profession from one generic scaffold. Aggregates each vertical's list data
 * into stats + sections + the shared activity feed.
 */

import { listActivityByPersona } from "../accountant/activity.service";
import { listContacts, listDeals } from "./sales/sales.service";
import { listTickets } from "./support/support.service";
import { listListings, listLeads, listShowings, listLeases } from "./realestate/realestate.service";
import { listCandidates, listOpenings } from "./hr/hr.vertical";
import { getRepos } from "../pm/github.service";
import { getBoards } from "../pm/trello.service";
import { searchIssues } from "../jira/jira.service";

export interface DashboardStat { label: string; value: string; tone?: "default" | "success" | "danger" }
export interface DashboardItem { id: string; title: string; subtitle?: string; badge?: string; tone?: "default" | "success" | "danger" | "warn" }
export interface DashboardSection { key: string; title: string; items: DashboardItem[] }
export interface DashboardActivityRow { id: string; title: string; detail: string | null; kind: string; createdAt: Date }
export interface DashboardData {
  persona: string;
  headline: string;
  stats: DashboardStat[];
  sections: DashboardSection[];
  /** Pending agent suggestions awaiting one-tap approval. */
  suggestions: DashboardActivityRow[];
  activity: DashboardActivityRow[];
  isEmpty: boolean;
}

const money = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;

function stageTone(stage: string): DashboardItem["tone"] {
  if (["won", "hired", "closed", "resolved", "sold"].includes(stage)) return "success";
  if (["lost", "rejected", "escalated"].includes(stage)) return "danger";
  return "default";
}

export async function buildDashboard(userId: string, persona: string): Promise<DashboardData> {
  const activityRows = await listActivityByPersona(userId, persona, 40);
  const map = (a: (typeof activityRows)[number]) => ({ id: a.id, title: a.title, detail: a.detail, kind: a.kind, createdAt: a.createdAt });
  const suggestions = activityRows.filter((a) => a.status === "suggested").map(map);
  const activity = activityRows.filter((a) => a.status === "done").slice(0, 20).map(map);

  let stats: DashboardStat[] = [];
  let sections: DashboardSection[] = [];
  let headline = "Your automated workspace";
  let isEmpty = false;

  if (persona === "sales") {
    const [deals, contacts] = await Promise.all([listDeals(userId), listContacts(userId)]);
    const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
    const won = deals.filter((d) => d.stage === "won");
    isEmpty = deals.length === 0 && contacts.length === 0;
    headline = `${open.length} open deal(s) worth ${money(open.reduce((s, d) => s + d.amountCents, 0))}.`;
    stats = [
      { label: "Pipeline", value: money(open.reduce((s, d) => s + d.amountCents, 0)) },
      { label: "Open deals", value: String(open.length) },
      { label: "Won", value: money(won.reduce((s, d) => s + d.amountCents, 0)), tone: "success" },
    ];
    sections = [
      { key: "deals", title: "Pipeline", items: deals.map((d) => ({ id: d.id, title: d.title, subtitle: `${d.company ?? ""} · ${money(d.amountCents)}`, badge: d.stage, tone: stageTone(d.stage) })) },
      { key: "contacts", title: "Contacts", items: contacts.map((c) => ({ id: c.id, title: c.name, subtitle: [c.title, c.company].filter(Boolean).join(" · ") })) },
    ];
  } else if (persona === "customer_support") {
    const tickets = await listTickets(userId);
    const open = tickets.filter((t) => t.status !== "resolved");
    isEmpty = tickets.length === 0;
    headline = `${open.length} open ticket(s), ${open.filter((t) => t.priority === "urgent").length} urgent.`;
    stats = [
      { label: "Open", value: String(open.length) },
      { label: "Urgent", value: String(open.filter((t) => t.priority === "urgent").length), tone: "danger" },
      { label: "Resolved", value: String(tickets.length - open.length), tone: "success" },
    ];
    sections = [
      { key: "tickets", title: "Tickets", items: tickets.map((t) => ({ id: t.id, title: t.subject, subtitle: `${t.customerName ?? "—"} · ${t.priority}`, badge: t.status, tone: t.status === "escalated" ? "danger" : t.status === "resolved" ? "success" : "default" })) },
    ];
  } else if (persona === "real_estate") {
    const [listings, leads, showings, leases] = await Promise.all([listListings(userId), listLeads(userId), listShowings(userId), listLeases(userId)]);
    const active = listings.filter((l) => l.status === "active" || l.status === "pending");
    isEmpty = listings.length === 0 && leads.length === 0;
    headline = `${active.length} active listing(s), ${leads.length} lead(s), ${showings.length} showing(s).`;
    stats = [
      { label: "Active", value: String(active.length) },
      { label: "Leads", value: String(leads.length) },
      { label: "Showings", value: String(showings.length) },
    ];
    sections = [
      { key: "listings", title: "Listings", items: listings.map((l) => ({ id: l.id, title: l.address, subtitle: `${money(l.priceCents)} · ${l.beds ?? "?"}bd/${l.baths ?? "?"}ba`, badge: l.status, tone: l.status === "sold" ? "success" : "default" })) },
      { key: "leads", title: "Buyer leads", items: leads.map((l) => ({ id: l.id, title: l.name, subtitle: l.interest ?? undefined, badge: l.stage, tone: stageTone(l.stage) })) },
      { key: "showings", title: "Showings", items: showings.map((s) => ({ id: s.id, title: s.address, subtitle: [s.leadName, s.scheduledAt ? new Date(s.scheduledAt).toLocaleString() : ""].filter(Boolean).join(" · ") })) },
      { key: "leases", title: "Leases", items: leases.map((l) => ({ id: l.id, title: l.property, subtitle: [l.tenantName, l.endDate ? `ends ${l.endDate}` : ""].filter(Boolean).join(" · ") })) },
    ];
  } else if (persona === "hr") {
    const [cands, openings] = await Promise.all([listCandidates(userId), listOpenings(userId)]);
    const active = cands.filter((c) => c.stage !== "hired" && c.stage !== "rejected");
    isEmpty = cands.length === 0 && openings.length === 0;
    headline = `${openings.filter((o) => o.status === "open").length} open role(s), ${active.length} active candidate(s).`;
    stats = [
      { label: "Open roles", value: String(openings.filter((o) => o.status === "open").length) },
      { label: "Candidates", value: String(active.length) },
      { label: "Interviewing", value: String(cands.filter((c) => c.stage === "interview").length) },
    ];
    sections = [
      { key: "candidates", title: "Candidates", items: cands.map((c) => ({ id: c.id, title: c.name, subtitle: [c.role, c.score != null ? `${c.score}/100` : ""].filter(Boolean).join(" · "), badge: c.stage, tone: stageTone(c.stage) })) },
      { key: "openings", title: "Open roles", items: openings.map((o) => ({ id: o.id, title: o.title, subtitle: [o.department, o.location].filter(Boolean).join(" · "), badge: o.status })) },
    ];
  } else if (persona === "product_manager") {
    // GitHub, Trello and Jira are independent connections — any combination may
    // be linked. Each getter throws when not connected, so swallow to an empty
    // list and surface a "connect" prompt rather than failing the whole page.
    const [repos, boards, issues] = await Promise.all([
      getRepos(userId).catch(() => []),
      getBoards(userId).catch(() => []),
      searchIssues(userId).catch(() => []),
    ]);
    const githubConnected = repos.length > 0;
    const trelloConnected = boards.length > 0;
    const jiraConnected = issues.length > 0;
    isEmpty = repos.length === 0 && boards.length === 0 && issues.length === 0;

    if (isEmpty) headline = "Connect GitHub, Trello or Jira to see your work.";
    else headline = `${repos.length} repo(s) · ${boards.length} board(s) · ${issues.length} Jira issue(s).`;

    stats = [
      { label: "Repos", value: String(repos.length) },
      { label: "Open issues", value: String(repos.reduce((s, r) => s + r.openIssues, 0)) },
      { label: "Boards", value: String(boards.length) },
      { label: "Jira", value: String(issues.length) },
    ];
    sections = [
      {
        key: "repos",
        title: "Repositories",
        items: githubConnected
          ? repos.map((r) => ({ id: String(r.id), title: r.fullName, subtitle: r.language ?? undefined, badge: `${r.openIssues} issues` }))
          : [{ id: "github-connect", title: "Connect GitHub", subtitle: "Settings → Connected Accounts", tone: "warn" }],
      },
      {
        key: "boards",
        title: "Trello boards",
        items: trelloConnected
          ? boards.map((b) => ({ id: b.id, title: b.name, subtitle: b.isStarred ? "★ Starred" : undefined, badge: "board" }))
          : [{ id: "trello-connect", title: "Connect Trello", subtitle: "Settings → Connected Accounts", tone: "warn" }],
      },
      {
        key: "jira",
        title: "Jira issues",
        items: jiraConnected
          ? issues.map((i) => ({ id: i.id, title: `${i.key} · ${i.summary}`, subtitle: i.assignee ?? undefined, badge: i.status, tone: stageTone(i.status.toLowerCase()) }))
          : [{ id: "jira-connect", title: "Connect Jira", subtitle: "Settings → Connected Accounts", tone: "warn" }],
      },
    ];
  }

  return { persona, headline, stats, sections, suggestions, activity, isEmpty };
}
