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

const SLACK_API = "https://slack.com/api";
const SLACK_OAUTH = "https://slack.com/oauth/v2/authorize";

const SLACK_BOT_SCOPES = ["chat:write", "channels:read", "channels:history", "users:read"];

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
  const base = process.env.SLACK_APP_REDIRECT ?? "interlinkapp://oauth/slack";
  const params = new URLSearchParams({ provider: "slack", status, ...(detail ? { detail } : {}) });
  return `${base}?${params}`;
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    scope: SLACK_BOT_SCOPES.join(","),
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
    authed_user?: { id?: string };
  };
  if (!data.ok || !data.access_token) {
    throw new BadRequestError(`Slack authorization failed: ${data.error ?? "unknown error"}`);
  }

  await upsertIntegration(
    userId,
    "slack",
    { accessToken: data.access_token, scopes: (data.scope ?? "").split(",").filter(Boolean) },
    {
      teamId: data.team?.id,
      teamName: data.team?.name,
      botUserId: data.bot_user_id,
      authedUserId: data.authed_user?.id,
    },
  );
}

// ─── Authed Slack Web API call ─────────────────────────────────────────────────

async function slackApi<T>(
  userId: string,
  method: string,
  params: Record<string, string> = {},
  httpMethod: "GET" | "POST" = "GET",
): Promise<T> {
  const integration = await getIntegration(userId, "slack");
  if (!integration || integration.status === "revoked") {
    throw new BadRequestError("Slack is not connected. Connect it from Settings → Connected Accounts.");
  }
  const token = integration.accessToken;

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
    throw new BadRequestError(`Slack API error (${method}): ${data.error ?? "unknown"}`);
  }
  return data;
}

// ─── Channels ──────────────────────────────────────────────────────────────────

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export async function getChannels(userId: string): Promise<SlackChannel[]> {
  const data = await slackApi<{
    channels?: { id?: string; name?: string; is_private?: boolean; is_member?: boolean }[];
  }>(userId, "conversations.list", { types: "public_channel", limit: "200", exclude_archived: "true" });
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

export async function postMessage(userId: string, channel: string, text: string): Promise<SlackPostedMessage> {
  const data = await slackApi<{ channel?: string; ts?: string }>(
    userId,
    "chat.postMessage",
    { channel, text },
    "POST",
  );
  return { channel: data.channel ?? channel, ts: data.ts ?? "" };
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
