/**
 * Trello REST API service (free, API key + OAuth token).
 * Tokens stored in connected_integrations table.
 */

import { getIntegration, upsertIntegration } from "../integrations/tokenStore";
import { BadRequestError } from "../../utils/errors";

const TRELLO_BASE = "https://api.trello.com/1";

function appKey(): string {
  const k = process.env.TRELLO_API_KEY;
  if (!k) throw new Error("TRELLO_API_KEY is not configured.");
  return k;
}
function redirectUri(): string {
  return process.env.TRELLO_REDIRECT_URI ?? `${process.env.API_BASE_URL}/api/v1/pm/trello/callback`;
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    key: appKey(),
    name: "Interlink",
    expiration: "never",
    response_type: "token",
    scope: "read,write",
    callback_method: "postMessage",
    return_url: redirectUri(),
    state,
  });
  return `https://trello.com/1/authorize?${params}`;
}

export async function storeToken(userId: string, token: string): Promise<void> {
  await upsertIntegration(userId, "trello", {
    accessToken: token,
    scopes: ["read", "write"],
  });
}

async function trelloFetch(
  userId: string,
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  const integration = await getIntegration(userId, "trello");
  if (!integration || integration.status === "revoked") {
    throw new BadRequestError("Trello is not connected. Connect it from Settings → Connected Accounts.");
  }
  const sep = path.includes("?") ? "&" : "?";
  return fetch(`${TRELLO_BASE}${path}${sep}key=${appKey()}&token=${integration.accessToken}`, opts);
}

// ─── Boards ───────────────────────────────────────────────────────────────────

export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  isStarred: boolean;
}

export async function getBoards(userId: string): Promise<TrelloBoard[]> {
  const res = await trelloFetch(userId, "/members/me/boards?filter=open&fields=id,name,url,starred");
  if (!res.ok) return [];
  const items = (await res.json()) as { id?: string; name?: string; url?: string; starred?: boolean }[];
  return items.map((b) => ({ id: b.id!, name: b.name ?? "", url: b.url ?? "", isStarred: b.starred ?? false }));
}

// ─── Cards / Tasks ────────────────────────────────────────────────────────────

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  due: string | null;
  dueComplete: boolean;
  listId: string;
  boardId: string;
  url: string;
  labels: { id: string; name: string; color: string }[];
}

export async function getCardsForBoard(userId: string, boardId: string): Promise<TrelloCard[]> {
  const res = await trelloFetch(userId, `/boards/${boardId}/cards?filter=open&fields=id,name,desc,due,dueComplete,idList,idBoard,url,labels`);
  if (!res.ok) return [];
  const items = (await res.json()) as {
    id?: string; name?: string; desc?: string; due?: string | null;
    dueComplete?: boolean; idList?: string; idBoard?: string; url?: string;
    labels?: { id?: string; name?: string; color?: string }[];
  }[];
  return items.map((c) => ({
    id: c.id!,
    name: c.name ?? "",
    desc: c.desc ?? "",
    due: c.due ?? null,
    dueComplete: c.dueComplete ?? false,
    listId: c.idList ?? "",
    boardId: c.idBoard ?? "",
    url: c.url ?? "",
    labels: (c.labels ?? []).map((l) => ({ id: l.id ?? "", name: l.name ?? "", color: l.color ?? "" })),
  }));
}

export async function createCard(
  userId: string,
  listId: string,
  data: { name: string; desc?: string; due?: string },
): Promise<TrelloCard> {
  const body = new URLSearchParams({
    idList: listId,
    name: data.name,
    ...(data.desc ? { desc: data.desc } : {}),
    ...(data.due ? { due: data.due } : {}),
  });
  const res = await trelloFetch(userId, "/cards", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("Failed to create Trello card");
  const c = (await res.json()) as TrelloCard & { idList?: string; idBoard?: string };
  return { ...c, listId: (c.idList ?? listId), boardId: (c.idBoard ?? "") };
}

export async function updateCard(
  userId: string,
  cardId: string,
  patch: { name?: string; desc?: string; due?: string; dueComplete?: boolean },
): Promise<void> {
  const body = new URLSearchParams(
    Object.fromEntries(
      Object.entries(patch)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ),
  );
  await trelloFetch(userId, `/cards/${cardId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

// ─── Lists (for card creation) ────────────────────────────────────────────────

export interface TrelloList {
  id: string;
  name: string;
  boardId: string;
}

export async function getListsForBoard(userId: string, boardId: string): Promise<TrelloList[]> {
  const res = await trelloFetch(userId, `/boards/${boardId}/lists?filter=open`);
  if (!res.ok) return [];
  const items = (await res.json()) as { id?: string; name?: string; idBoard?: string }[];
  return items.map((l) => ({ id: l.id!, name: l.name ?? "", boardId: l.idBoard ?? boardId }));
}
