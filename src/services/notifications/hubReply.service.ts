/**
 * Inline reply for Gmail items in the hub.
 *
 * THE POINT OF THE WHOLE FEATURE lives here. A notification list that can only say "you have
 * mail" is a nicer inbox; being able to answer without leaving is what makes this a command
 * centre. It is also what the success metric measures — inline actions versus deep-links out.
 *
 * THE DRAFT IS NEVER SENT AUTOMATICALLY. `draftReply` proposes, the user edits, `sendReply`
 * sends what the user approved — the same draft/preview/confirm shape the decline-email flow
 * already uses. One-tap send of model-written text to a real colleague is the failure mode that
 * gets a feature switched off after a single bad send, so the edit step is load-bearing, not
 * friction. `sendReply` deliberately takes the body as an argument and never regenerates it:
 * the server sends the exact text the user saw.
 *
 * Scope note: `gmail.compose` covers sending. We do NOT have `gmail.modify`, so replying cannot
 * mark the thread read in Gmail — the hub resolves its own item instead, and the next poll
 * confirms it (the thread stops matching `is:unread`).
 */

import { query } from "../../config/db";
import { logger } from "../../observability/logger";
import { geminiGenerateContent, isGeminiLive } from "../ai/geminiClient";
import {
  getGmailMessageDetail,
  sendAutomatedGmailMessage,
} from "../googleApi.service";
import { getGoogleAccountSummaryById, resolveGoogleAccount } from "../auth.service";
import { NotFoundError, BadRequestError } from "../../utils/errors";
import { recordAction } from "./hub.service";

interface ItemRow {
  id: string;
  source: string;
  kind: string;
  title: string;
  external_ref: {
    threadId?: string;
    messageId?: string;
    googleAccountId?: string;
  };
  mode: "personal" | "professional";
}

async function loadGmailItem(userId: string, itemId: string): Promise<ItemRow> {
  const res = await query<ItemRow>(
    `SELECT id, source, kind, title, external_ref, mode
       FROM notification_items
      WHERE id = $1 AND user_id = $2`,
    [itemId, userId],
  );
  const item = res.rows[0];
  if (!item) throw new NotFoundError("Notification not found.");
  if (item.source !== "gmail" || !item.external_ref?.messageId) {
    throw new BadRequestError("This notification is not an email thread.");
  }
  return item;
}

/** "Ada Lovelace <ada@example.com>" -> "ada@example.com" */
function addressOf(header: string | null): string | null {
  if (!header) return null;
  const angled = header.match(/<([^>]+)>/);
  const value = (angled ? angled[1] : header).trim();
  return value.includes("@") ? value : null;
}

function nameOf(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^\s*"?([^"<]+?)"?\s*<.+>\s*$/);
  const name = (match ? match[1] : header).trim();
  return name.includes("@") ? null : name || null;
}

const DRAFT_SYSTEM = `You draft a SHORT reply to a work email, in the voice of the person replying.

Rules:
- 2-4 sentences. No subject line, no greeting block, no signature — just the body.
- Answer or acknowledge what was actually asked. Do not invent facts, dates, numbers or promises.
- If the email asks something you cannot know, say you will follow up rather than guessing.
- Plain, warm, direct. No corporate filler, no "I hope this email finds you well", no emoji.
- This is a DRAFT a human will read and edit before sending. Do not add placeholders like
  [YOUR NAME] — the sender's signature is added separately.

Respond with the JSON object only. No preamble, no code fence.`;

export interface ReplyDraft {
  to: string;
  toName: string | null;
  subject: string;
  body: string;
  /** True when the model was unavailable and a neutral holding reply was used instead. */
  isFallback: boolean;
  /** The quoted message the draft is answering, for the confirm screen. */
  originalSnippet: string;
}

/**
 * Propose a reply. Read-only: nothing is sent and nothing is mutated.
 */
export async function draftReply(userId: string, itemId: string): Promise<ReplyDraft> {
  const item = await loadGmailItem(userId, itemId);

  const detail = await getGmailMessageDetail({
    userId,
    googleAccountId: item.external_ref.googleAccountId ?? null,
    messageId: item.external_ref.messageId!,
  });

  const to = addressOf(detail.from);
  if (!to) {
    throw new BadRequestError("Could not determine who to reply to.");
  }

  const subject = detail.subject?.startsWith("Re:")
    ? detail.subject
    : `Re: ${detail.subject ?? "(no subject)"}`;

  const original = (detail.bodyText ?? detail.snippet ?? "").slice(0, 4000);

  // A neutral holding reply — honest, sendable, and never wrong about facts it cannot know.
  const fallbackBody =
    "Thanks for this — I've seen it and I'll come back to you shortly with a proper reply.";

  if (!isGeminiLive()) {
    return {
      to,
      toName: nameOf(detail.from),
      subject,
      body: fallbackBody,
      isFallback: true,
      originalSnippet: original.slice(0, 400),
    };
  }

  try {
    const result = await geminiGenerateContent({
      system: DRAFT_SYSTEM,
      parts: [
        {
          text:
            `From: ${detail.from ?? "unknown"}\n` +
            `Subject: ${detail.subject ?? "(no subject)"}\n\n` +
            `${original}`,
        },
      ],
      json: true,
      responseSchema: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
      },
      tier: "reasoning",
      // Thinking tokens come out of this same budget — see hubSummary.service.ts for the
      // truncation this caused when the budget was tight.
      thinkingBudget: 0,
      maxOutputTokens: 800,
    });

    const parsed = JSON.parse(result.raw) as { body?: unknown };
    const body =
      typeof parsed.body === "string" && parsed.body.trim()
        ? parsed.body.trim()
        : null;

    return {
      to,
      toName: nameOf(detail.from),
      subject,
      body: body ?? fallbackBody,
      isFallback: body === null,
      originalSnippet: original.slice(0, 400),
    };
  } catch (err) {
    logger.warn("[hub:reply] draft generation failed — using holding reply", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      to,
      toName: nameOf(detail.from),
      subject,
      body: fallbackBody,
      isFallback: true,
      originalSnippet: original.slice(0, 400),
    };
  }
}

/**
 * Send the reply the user approved, then resolve the hub item.
 *
 * `body` comes from the client on purpose — it is what the user actually saw and edited.
 * Regenerating server-side would mean sending text nobody read, which is exactly the failure the
 * edit step exists to prevent.
 */
export async function sendReply(
  userId: string,
  itemId: string,
  body: string,
  requestId?: string,
): Promise<{ threadId: string }> {
  if (!body.trim()) throw new BadRequestError("Reply body is required.");

  const item = await loadGmailItem(userId, itemId);

  const detail = await getGmailMessageDetail({
    userId,
    googleAccountId: item.external_ref.googleAccountId ?? null,
    messageId: item.external_ref.messageId!,
  });

  const to = addressOf(detail.from);
  if (!to) throw new BadRequestError("Could not determine who to reply to.");

  // Send FROM the account the thread belongs to — a work thread must not reply from the
  // personal mailbox. Same rule the decline-email path follows.
  const account = item.external_ref.googleAccountId
    ? await getGoogleAccountSummaryById(item.external_ref.googleAccountId)
    : await resolveGoogleAccount(userId, item.mode);

  if (!account?.email) {
    throw new BadRequestError("No Google account is connected to send from.");
  }

  const subject = detail.subject?.startsWith("Re:")
    ? detail.subject
    : `Re: ${detail.subject ?? "(no subject)"}`;

  const sent = await sendAutomatedGmailMessage({
    userId,
    googleAccountId: account.id,
    fromEmail: account.email,
    toEmail: to,
    subject,
    body: body.trim(),
    threadId: item.external_ref.threadId,
    inReplyToMessageId: detail.messageIdHeader ?? undefined,
  });

  // Counts as an inline action — the numerator of the success metric.
  await recordAction(userId, itemId, "resolve", requestId);

  logger.info("[hub:reply] sent", { userId, itemId, threadId: sent.threadId });
  return { threadId: sent.threadId };
}
