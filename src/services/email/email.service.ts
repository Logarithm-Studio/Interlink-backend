/**
 * Email service — provider-agnostic draft creation dispatcher.
 *
 * Currently routes all requests to Gmail.  When Step 16 is extended for
 * Microsoft Outlook, add an `outlook.service.ts` and a branch here.
 *
 * This module is the only entry point the workflow step handler calls — it
 * resolves the correct provider from the user's connected accounts and
 * dispatches to the provider-specific service.
 *
 * Routing priority (when the user has multiple accounts connected):
 *   1. If the step config specifies a `provider`, use that.
 *   2. Otherwise prefer `google` (Gmail), then `microsoft` (Outlook).
 *
 * Provider not connected → throws `ProviderNotConnectedError` (permanent failure).
 */

import { query } from "../../config/db";
import {
  createGmailDraft,
  computeDraftIdempotencyKey,
  sendGmailDraft,
  AuthError,
  GmailDraftResult,
  GmailSendResult,
} from "./gmail.service";

// ─── Public types ─────────────────────────────────────────────────────────────

export { AuthError };

export interface CreateEmailDraftParams {
  executionId: string;
  stepId: string;
  userId: string;
  /** Target provider override.  If absent, auto-detected from connected accounts. */
  provider?: "gmail" | "outlook";
  /** One or more recipient email addresses (organizer/self already excluded by caller). */
  recipients: string[];
  subject: string;
  /** Plain-text body. */
  body: string;
}

export interface CreateEmailDraftResult {
  emailDraftId: string;
  providerDraftId: string;
  provider: "gmail" | "outlook";
  isNew: boolean;
}

// ─── Provider detection ───────────────────────────────────────────────────────

async function detectProvider(
  userId: string,
  preferred?: "gmail" | "outlook",
): Promise<"gmail" | "outlook"> {
  if (preferred) return preferred;

  const res = await query<{ provider: string }>(
    `SELECT provider FROM connected_accounts
      WHERE user_id = $1
      ORDER BY CASE provider WHEN 'google' THEN 1 WHEN 'microsoft' THEN 2 ELSE 3 END
      LIMIT 2`,
    [userId],
  );

  const providers = res.rows.map((r) => r.provider);

  if (providers.includes("google")) return "gmail";
  if (providers.includes("microsoft")) return "outlook";

  throw new ProviderNotConnectedError(
    `No email provider connected for user ${userId}. ` +
      "User must connect a Google or Microsoft account.",
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Dispatch a draft-creation request to the appropriate email provider.
 *
 * The idempotency key is computed deterministically from
 * (executionId, stepId, recipient, subject) so retries are safe.
 *
 * @throws `ProviderNotConnectedError` — no supported account connected (permanent).
 * @throws `AuthError`                 — OAuth token invalid / revoked (permanent).
 * @throws Any other error             — treated as transient by BullMQ.
 */
export async function createEmailDraft(
  params: CreateEmailDraftParams,
): Promise<CreateEmailDraftResult> {
  const provider = await detectProvider(params.userId, params.provider);

  const idempotencyKey = computeDraftIdempotencyKey(
    params.executionId,
    params.stepId,
    params.recipients,
    params.subject,
  );

  if (provider === "gmail") {
    const result: GmailDraftResult = await createGmailDraft({
      executionId: params.executionId,
      stepId: params.stepId,
      userId: params.userId,
      recipients: params.recipients,
      subject: params.subject,
      body: params.body,
      idempotencyKey,
    });

    return {
      emailDraftId: result.emailDraftId,
      providerDraftId: result.providerDraftId,
      provider: "gmail",
      isNew: result.isNew,
    };
  }

  // "outlook" — not yet implemented; will be added when Step 16 is extended.
  throw new ProviderNotConnectedError(
    `Email provider "outlook" is not yet implemented. ` +
      "Connect a Google account to use Gmail draft creation.",
  );
}

// ─── Error types ──────────────────────────────────────────────────────────────

export class ProviderNotConnectedError extends Error {
  readonly isProviderNotConnectedError = true;
  constructor(message: string) {
    super(message);
    this.name = "ProviderNotConnectedError";
  }
}

// ─── Send an email (create draft + send) ──────────────────────────────────────

export interface SendEmailParams {
  executionId: string;
  stepId: string;
  userId: string;
  provider?: "gmail" | "outlook";
  /** One or more recipient email addresses (organizer/self already excluded by caller). */
  recipients: string[];
  subject: string;
  body: string;
}

export interface SendEmailResult {
  emailDraftId: string;
  providerDraftId: string;
  messageId: string;
  threadId: string;
  provider: "gmail" | "outlook";
  alreadySent: boolean;
}

/**
 * Create a draft and immediately send it.
 *
 * 1. Detect provider (same logic as `createEmailDraft()`).
 * 2. Create the draft idempotently.
 * 3. Send the draft via `users.drafts.send` (Gmail).
 *
 * The two-step create→send approach provides an audit trail: the draft row
 * records what was sent and when.
 */
export async function sendEmail(
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const provider = await detectProvider(params.userId, params.provider);

  if (provider !== "gmail") {
    throw new ProviderNotConnectedError(
      `Email provider "outlook" is not yet implemented. ` +
        "Connect a Google account to use Gmail.",
    );
  }

  // Step 1: create draft idempotently
  const draftIdempotencyKey = computeDraftIdempotencyKey(
    params.executionId,
    params.stepId,
    params.recipients,
    params.subject,
  );

  const draftResult: GmailDraftResult = await createGmailDraft({
    executionId: params.executionId,
    stepId: params.stepId,
    userId: params.userId,
    recipients: params.recipients,
    subject: params.subject,
    body: params.body,
    idempotencyKey: draftIdempotencyKey,
  });

  // Step 2: send the draft
  const sendIdempotencyKey = `email:send:${params.executionId}:${params.stepId}`;

  const sendResult: GmailSendResult = await sendGmailDraft({
    executionId: params.executionId,
    stepId: params.stepId,
    userId: params.userId,
    providerDraftId: draftResult.providerDraftId,
    idempotencyKey: sendIdempotencyKey,
  });

  return {
    emailDraftId: draftResult.emailDraftId,
    providerDraftId: draftResult.providerDraftId,
    messageId: sendResult.messageId,
    threadId: sendResult.threadId,
    provider: "gmail",
    alreadySent: sendResult.alreadySent,
  };
}
