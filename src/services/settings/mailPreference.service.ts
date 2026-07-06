/**
 * Mailbox provider preference (Gmail ↔ Outlook) + a small read dispatch layer so the
 * Mails tab shows whichever provider the user picked. Sending is handled per-provider
 * by the assistant tools (send_outlook_mail / the Gmail send path) — not unified here.
 */

import { query } from "../../config/db";
import { BadRequestError } from "../../utils/errors";
import { getTokens } from "../auth.service";
import { getIntegration } from "../integrations/tokenStore";
import { listGmailMailboxMessages } from "../googleApi.service";
import { listOutlookMessages } from "../microsoft/microsoft.service";

export type MailProvider = "gmail" | "outlook";

export async function getMailProvider(userId: string): Promise<MailProvider> {
  const res = await query<{ mail_provider: MailProvider }>(
    `SELECT mail_provider FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return res.rows[0]?.mail_provider ?? "gmail";
}

/** True when the given provider is actually connected for the user. */
async function isProviderConnected(userId: string, provider: MailProvider): Promise<boolean> {
  if (provider === "gmail") {
    try {
      return Boolean(await getTokens(userId, "google"));
    } catch {
      return true; // reauth-required still means an account exists
    }
  }
  const integration = await getIntegration(userId, "microsoft");
  return Boolean(integration && integration.status !== "revoked");
}

export async function setMailProvider(userId: string, provider: MailProvider): Promise<void> {
  if (provider !== "gmail" && provider !== "outlook") {
    throw new BadRequestError("mail_provider must be 'gmail' or 'outlook'.");
  }
  if (!(await isProviderConnected(userId, provider))) {
    throw new BadRequestError(
      provider === "outlook"
        ? "Connect Microsoft (Settings → Connected Accounts) before switching to Outlook mail."
        : "Connect your Google account before switching to Gmail.",
    );
  }
  await query(`UPDATE users SET mail_provider = $2 WHERE id = $1`, [userId, provider]);
}

export interface UnifiedMessage {
  id: string;
  subject: string;
  from: string;
  preview: string;
}

/** List the active mailbox's recent messages in a provider-agnostic shape. */
export async function listActiveMailbox(
  userId: string,
  limit = 15,
): Promise<{ provider: MailProvider; messages: UnifiedMessage[] }> {
  const provider = await getMailProvider(userId);
  if (provider === "outlook") {
    const msgs = await listOutlookMessages(userId, limit);
    return { provider, messages: msgs.map((m) => ({ id: m.id, subject: m.subject, from: m.from, preview: m.preview })) };
  }
  const msgs = await listGmailMailboxMessages({ userId, mailbox: "inbox", maxResults: limit });
  return {
    provider,
    messages: msgs.map((m) => ({
      id: m.id,
      subject: m.subject ?? "(no subject)",
      from: m.from ?? "unknown sender",
      preview: m.snippet ?? "",
    })),
  };
}
