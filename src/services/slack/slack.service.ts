/**
 * Slack integration — OAuth v2 (bot token), free.
 * Tokens stored (encrypted) in connected_integrations table.
 *
 * Flow differs from the app's custom-scheme providers: Slack blocks custom URI
 * schemes unless PKCE is used, so we use an https backend callback instead. Slack
 * redirects the browser to GET /api/v1/slack/callback (no JWT); the callback
 * resolves the user via the opaque `state` token, exchanges the code, stores the
 * bot token, then deep-links back into the app.
 *
 * Bot tokens (xoxb-…) do not expire, so no refresh handling is required.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { getIntegration, upsertIntegration } from "../integrations/tokenStore";
import { BadRequestError } from "../../utils/errors";
import { appRedirect as oauthAppRedirect } from "../integrations/oauthAppRedirect";

const SLACK_API = "https://slack.com/api";
const SLACK_OAUTH = "https://slack.com/oauth/v2/authorize";

const SLACK_BOT_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "users:read",
];

const SLACK_USER_SCOPES = [
  "chat:write",
  // Open a direct-message channel with a person so we can DM their inbox, not just
  // post to channels. Existing users must reconnect Slack to grant it.
  "im:write",
];

function clientId(): string {
  const id = process.env.SLACK_CLIENT_ID;
  if (!id) throw new Error("SLACK_CLIENT_ID is not configured.");
  return id;
}
function clientSecret(): string {
  const s = process.env.SLACK_CLIENT_SECRET;
  if (!s) throw new Error("SLACK_CLIENT_SECRET is not configured.");
  return s;
}
function redirectUri(): string {
  // Must be the https backend callback registered in the Slack app config.
  return (
    process.env.SLACK_REDIRECT_URI ??
    `${process.env.API_BASE_URL ?? "http://localhost:5000"}/api/v1/slack/callback`
  );
}

/** Deep link the browser is sent to after the backend finishes the exchange. */
export function appRedirect(status: "success" | "error", detail?: string): string {
  if (!process.env.SLACK_APP_REDIRECT) return oauthAppRedirect("slack", status, detail);
  const base = process.env.SLACK_APP_REDIRECT;
  const params = new URLSearchParams({ provider: "slack", status, ...(detail ? { detail } : {}) });
  return `${base}?${params}`;
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    scope: SLACK_BOT_SCOPES.join(","),
    user_scope: SLACK_USER_SCOPES.join(","),
    redirect_uri: redirectUri(),
    state,
  });
  return `${SLACK_OAUTH}?${params}`;
}

export async function exchangeCode(userId: string, code: string): Promise<void> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    redirect_uri: redirectUri(),
  });
  const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    access_token?: string; // bot token (xoxb-…)
    scope?: string;
    team?: { id?: string; name?: string };
    bot_user_id?: string;
    authed_user?: { id?: string; access_token?: string; scope?: string; token_type?: string };
  };
  if (!data.ok || !data.access_token) {
    throw new BadRequestError(`Slack authorization failed: ${data.error ?? "unknown error"}`);
  }
  if (!data.authed_user?.access_token) {
    throw new BadRequestError("Slack authorization did not return a user token. Reconnect Slack and approve posting as yourself.");
  }

  await upsertIntegration(
    userId,
    "slack",
    {
      accessToken: data.access_token,
      refreshToken: data.authed_user.access_token,
      scopes: [
        ...(data.scope ?? "").split(",").filter(Boolean).map((scope) => `bot:${scope}`),
        ...(data.authed_user.scope ?? "").split(",").filter(Boolean).map((scope) => `user:${scope}`),
      ],
    },
    {
      teamId: data.team?.id,
      teamName: data.team?.name,
      botUserId: data.bot_user_id,
      authedUserId: data.authed_user?.id,
      postsAs: "user",
    },
  );
}

// ─── Authed Slack Web API call ─────────────────────────────────────────────────

async function slackApi<T>(
  userId: string,
  method: string,
  params: Record<string, string> = {},
  httpMethod: "GET" | "POST" = "GET",
  tokenKind: "bot" | "user" = "bot",
): Promise<T> {
  const integration = await getIntegration(userId, "slack");
  if (!integration || integration.status === "revoked") {
    throw new BadRequestError("Slack is not connected. Connect it from Settings → Connected Accounts.");
  }
  const token = tokenKind === "user" ? integration.refreshToken : integration.accessToken;
  if (!token) {
    throw new BadRequestError("Reconnect Slack in Connected Accounts to approve posting as yourself.");
  }

  let res: Response;
  if (httpMethod === "GET") {
    const qs = new URLSearchParams(params).toString();
    res = await fetch(`${SLACK_API}/${method}${qs ? `?${qs}` : ""}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } else {
    res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    });
  }

  const data = (await res.json()) as T & { ok: boolean; error?: string };
  if (!data.ok) {
    throw new BadRequestError(slackErrorMessage(method, data.error));
  }
  return data;
}

function slackErrorMessage(method: string, error?: string): string {
  switch (error) {
    case "missing_scope":
      return "Slack permission is missing. Disconnect and reconnect Slack in Connected Accounts to approve the updated permissions.";
    case "not_in_channel":
      return "The Slack app is not in that channel. Reconnect Slack to grant public posting, or invite the app to the channel.";
    case "channel_not_found":
      return "Slack could not find that channel, or the app does not have access to it.";
    case "invalid_auth":
    case "token_revoked":
      return "Slack authorization is no longer valid. Reconnect Slack in Connected Accounts.";
    default:
      return `Slack API error (${method}): ${error ?? "unknown"}`;
  }
}

// ─── Channels ──────────────────────────────────────────────────────────────────

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export async function getChannels(userId: string): Promise<SlackChannel[]> {
  let data: { channels?: { id?: string; name?: string; is_private?: boolean; is_member?: boolean }[] };
  try {
    data = await slackApi(
      userId,
      "conversations.list",
      { types: "public_channel,private_channel", limit: "200", exclude_archived: "true" },
    );
  } catch (err) {
    if (!(err instanceof BadRequestError) || !err.message.includes("permission is missing")) throw err;
    data = await slackApi(
      userId,
      "conversations.list",
      { types: "public_channel", limit: "200", exclude_archived: "true" },
    );
  }
  return (data.channels ?? []).map((c) => ({
    id: c.id ?? "",
    name: c.name ?? "",
    isPrivate: c.is_private ?? false,
    isMember: c.is_member ?? false,
  }));
}

// ─── Messages ──────────────────────────────────────────────────────────────────

export interface SlackPostedMessage {
  channel: string;
  ts: string;
}

export async function postMessage(
  userId: string,
  channel: string,
  text: string,
  opts: { asUser?: boolean } = {},
): Promise<SlackPostedMessage> {
  const data = await slackApi<{ channel?: string; ts?: string }>(
    userId,
    "chat.postMessage",
    { channel, text },
    "POST",
    opts.asUser === false ? "bot" : "user",
  );
  return { channel: data.channel ?? channel, ts: data.ts ?? "" };
}

/**
 * Send a direct message to a person by name (resolves them from the workspace member
 * list, opens the IM channel, then posts). This is what makes "DM Sarah that I'm running
 * late" work — plain channel posting can't reach a person's inbox.
 */
export async function sendDirectMessage(
  userId: string,
  personQuery: string,
  text: string,
): Promise<{ channel: string; ts: string; to: string }> {
  const q = personQuery.trim().toLowerCase();
  if (!q) throw new BadRequestError("Tell me who to message.");

  const users = await getUsers(userId);
  const candidates = users.filter((u) => !u.isBot);
  const match =
    candidates.find((u) => u.realName.toLowerCase() === q || u.name.toLowerCase() === q) ??
    candidates.find((u) => u.realName.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
  if (!match) throw new BadRequestError(`I couldn't find "${personQuery}" in your Slack workspace.`);

  // Open (or fetch) the IM channel with that user, then post into it.
  const opened = await slackApi<{ channel?: { id?: string } }>(
    userId,
    "conversations.open",
    { users: match.id },
    "POST",
    "user",
  );
  const channel = opened.channel?.id;
  if (!channel) throw new BadRequestError("Slack couldn't open a direct message with that person.");

  const posted = await postMessage(userId, channel, text);
  return { channel: posted.channel, ts: posted.ts, to: match.realName || match.name };
}

/** Read recent messages from a channel (newest first) — used to monitor bug/alert channels. */
export async function getRecentMessages(userId: string, channel: string, limit = 20): Promise<string[]> {
  const data = await slackApi<{ messages?: { text?: string; subtype?: string }[] }>(
    userId,
    "conversations.history",
    { channel, limit: String(limit) },
  );
  return (data.messages ?? [])
    .filter((m) => !m.subtype && (m.text ?? "").trim().length > 0)
    .map((m) => m.text ?? "");
}

// ─── Users ─────────────────────────────────────────────────────────────────────

export interface SlackUser {
  id: string;
  name: string;
  realName: string;
  isBot: boolean;
}

export async function getUsers(userId: string): Promise<SlackUser[]> {
  const data = await slackApi<{
    members?: { id?: string; name?: string; real_name?: string; is_bot?: boolean; deleted?: boolean }[];
  }>(userId, "users.list", { limit: "200" });
  return (data.members ?? [])
    .filter((m) => !m.deleted)
    .map((m) => ({ id: m.id ?? "", name: m.name ?? "", realName: m.real_name ?? "", isBot: m.is_bot ?? false }));
}

// ─── Request signature verification (for a future events endpoint) ──────────────

/**
 * Verify an incoming Slack request signature per
 * https://api.slack.com/authentication/verifying-requests-from-slack.
 * `rawBody` must be the exact bytes Slack sent (captured in app.ts).
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;

  // Reject stale requests (>5 min) to prevent replay attacks.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}
