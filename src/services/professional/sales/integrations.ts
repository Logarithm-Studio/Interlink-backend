/**
 * Sales ↔ connected-app sync (Trello two-way + Slack push).
 *
 * Gated on the integration being connected; degrades to a friendly "connect X"
 * message otherwise (mirrors the PM vertical pattern). Reuses the existing
 * Trello/Slack services and the self-contained sales CRM.
 */

import { AppUser } from "../../../types";
import { recordActivity } from "../../accountant/activity.service";
import { isConnected } from "../../integrations/tokenStore";
import { getBoards, getListsForBoard, getCardsForBoard, createCard, updateCard } from "../../pm/trello.service";
import { getChannels, postMessage } from "../../slack/slack.service";
import { listDeals, createDeal, getOverview, type DealStage } from "./sales.service";

const PERSONA = "sales";
type Result = { ok: boolean; message: string };

const STAGE_LABELS: Record<DealStage, string> = {
  lead: "Lead", qualified: "Qualified", proposal: "Proposal", negotiation: "Negotiation",
  won: "Won", lost: "Lost", nurture: "Nurture",
};
const STAGES = Object.keys(STAGE_LABELS) as DealStage[];

function fmtMoney(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/** Best-effort map a Trello list name back to a pipeline stage. */
function inferStage(listName: string): DealStage {
  const n = listName.toLowerCase();
  return STAGES.find((s) => n.includes(s) || n.includes(STAGE_LABELS[s].toLowerCase())) ?? "lead";
}

/** One-line connection status for the agent snapshot. */
export async function salesConnectionsLine(userId: string): Promise<string> {
  const [trello, slack] = await Promise.all([isConnected(userId, "trello"), isConnected(userId, "slack")]);
  return `Connected apps — Trello ${trello ? "✓" : "✗"} · Slack ${slack ? "✓" : "✗"}.`;
}

// ─── Push: pipeline → Trello ────────────────────────────────────────────────────

export async function syncPipelineToTrello(user: AppUser): Promise<Result> {
  if (!(await isConnected(user.id, "trello"))) return { ok: false, message: "Connect Trello in Settings → Manage Integrations to sync your pipeline." };
  const boards = await getBoards(user.id);
  if (boards.length === 0) return { ok: false, message: "No Trello board found. Create a board in Trello, then try again." };
  const board = boards[0];
  const [lists, cards, deals] = await Promise.all([
    getListsForBoard(user.id, board.id),
    getCardsForBoard(user.id, board.id),
    listDeals(user.id),
  ]);
  if (lists.length === 0) return { ok: false, message: `Your board "${board.name}" has no lists. Add a list, then try again.` };

  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  let created = 0;
  let updated = 0;
  for (const deal of open) {
    const label = STAGE_LABELS[deal.stage];
    const target =
      lists.find((l) => l.name.toLowerCase().includes(deal.stage) || l.name.toLowerCase().includes(label.toLowerCase())) ??
      lists[0];
    const desc = `Stage: ${label} · ${fmtMoney(deal.amountCents)}${deal.company ? ` · ${deal.company}` : ""}${deal.contactName ? ` · ${deal.contactName}` : ""}`;
    const existing = cards.find((c) => c.name.toLowerCase() === deal.title.toLowerCase());
    try {
      if (existing) { await updateCard(user.id, existing.id, { desc }); updated++; }
      else { await createCard(user.id, target.id, { name: deal.title, desc }); created++; }
    } catch { /* skip a single card failure */ }
  }

  await recordActivity({
    userId: user.id, persona: PERSONA, kind: "trello_sync",
    title: `Synced pipeline to Trello board "${board.name}"`, detail: `${created} new, ${updated} updated`,
  });
  return { ok: true, message: `Synced ${created + updated} deal(s) to Trello board "${board.name}" (${created} new, ${updated} updated).` };
}

// ─── Pull: Trello cards → deals ─────────────────────────────────────────────────

export async function importDealsFromTrello(user: AppUser): Promise<Result> {
  if (!(await isConnected(user.id, "trello"))) return { ok: false, message: "Connect Trello in Settings → Manage Integrations to import cards." };
  const boards = await getBoards(user.id);
  if (boards.length === 0) return { ok: false, message: "No Trello board found to import from." };
  const board = boards[0];
  const [lists, cards, deals] = await Promise.all([
    getListsForBoard(user.id, board.id),
    getCardsForBoard(user.id, board.id),
    listDeals(user.id),
  ]);
  const listName = new Map(lists.map((l) => [l.id, l.name]));
  const existing = new Set(deals.map((d) => d.title.toLowerCase()));

  let imported = 0;
  for (const card of cards) {
    if (existing.has(card.name.toLowerCase())) continue;
    const stage = inferStage(listName.get(card.listId) ?? "");
    try {
      await createDeal(user.id, { title: card.name, stage, notes: card.desc || undefined, source: "trello" });
      imported++;
    } catch { /* skip */ }
  }

  await recordActivity({
    userId: user.id, persona: PERSONA, kind: "trello_import",
    title: `Imported ${imported} deal(s) from Trello board "${board.name}"`,
  });
  return { ok: true, message: imported > 0 ? `Imported ${imported} new deal(s) from Trello board "${board.name}".` : `No new cards to import from "${board.name}" — your pipeline is already in sync.` };
}

// ─── Push: pipeline digest → Slack ──────────────────────────────────────────────

export async function postPipelineDigestToSlack(user: AppUser, channel?: string): Promise<Result> {
  if (!(await isConnected(user.id, "slack"))) return { ok: false, message: "Connect Slack in Settings → Manage Integrations to post updates." };
  const overview = await getOverview(user.id);

  let target = (channel ?? "").trim();
  if (target) {
    // Accept a channel name (with/without #) as well as an id.
    if (!/^[CG][A-Z0-9]/.test(target)) {
      const clean = target.replace(/^#/, "").toLowerCase();
      const match = (await getChannels(user.id)).find((c) => c.name.toLowerCase() === clean);
      if (match) target = match.id;
    }
  } else {
    const channels = await getChannels(user.id);
    const first = channels.find((c) => c.isMember) ?? channels[0];
    if (!first) return { ok: false, message: "No Slack channel is available to post to." };
    target = first.id;
  }

  const text =
    `*Sales pipeline digest*\n${overview.briefing}\n` +
    `Open deals: ${overview.openCount} · Pipeline ${fmtMoney(overview.pipelineValueCents)} · ` +
    `Won ${fmtMoney(overview.wonValueCents)} · Contracts out ${overview.contractsOut}`;
  await postMessage(user.id, target, text);

  await recordActivity({ userId: user.id, persona: PERSONA, kind: "slack_digest", title: "Posted pipeline digest to Slack" });
  return { ok: true, message: "Posted your pipeline digest to Slack." };
}
