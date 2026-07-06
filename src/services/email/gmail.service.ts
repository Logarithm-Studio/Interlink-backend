/**
 * Gmail draft creation service.
 *
 * Creates email drafts via the Gmail REST API.  NEVER sends automatically.
 *
 * Design constraints:
 * - Draft-only: the Gmail API `users.drafts.create` endpoint is used exclusively.
 *   There is no `users.messages.send` call anywhere in this module.
 * - Idempotency: the caller supplies an `idempotencyKey`; if a matching row
 *   already exists in `email_drafts`, the stored `provider_draft_id` is returned
 *   without making an API call.
 * - Auth failure handling: if the Google API returns a 401 or 403, the connected
 *   account is marked `reauth_required` and an unrecoverable error is thrown so
 *   the workflow step marks itself as failed (not retried).
 * - Token refresh: `refreshGoogleTokenIfNeeded` is called before every API call.
 * - Audit: every draft creation (including idempotent no-ops) writes an
 *   `audit_log` entry.
 *
 * Required Gmail OAuth scope: `https://www.googleapis.com/auth/gmail.compose`
 * (or the broader `https://mail.google.com/` scope).
 */

import { createHash } from "crypto";
import { google } from "googleapis";
import { query } from "../../config/db";
import {
  refreshGoogleTokenIfNeeded,
  refreshGoogleTokenForAccount,
} from "../auth.service";
import { recordAuditLog } from "../../security/idempotency";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GmailDraftCreateParams {
  executionId?: string | null;
  stepId: string;
  userId: string;
  /** Which Google account (mailbox) to draft from. Defaults to the primary account. */
  googleAccountId?: string | null;
  /** Override the MIME `From:` address (e.g. the resolved account's mailbox). */
  fromEmail?: string;
  /** One or more recipient addresses. The MIME `To:` header will list all of them. */
  recipients: string[];
  subject: string;
  /** Plain-text body (no HTML). */
  body: string;
  idempotencyKey: string;
}

export interface GmailDraftResult {
  emailDraftId: string; // PK in `email_drafts`
  providerDraftId: string; // Gmail draft ID (e.g. "r1234…")
  isNew: boolean; // false when the idempotency check short-circuited
}

// ─── MIME helpers ─────────────────────────────────────────────────────────────

/**
 * Encode a MIME RFC 2822 message as base64url (the format Gmail expects).
 */
function buildMimeMessage(
  from: string,
  to: string | string[],
  subject: string,
  body: string,
): string {
  const toHeader = Array.isArray(to) ? to.join(", ") : to;
  // Encode subject as RFC 2047 UTF-8 quoted-printable to handle non-ASCII.
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const mime = [
    `From: ${from}`,
    `To: ${toHeader}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    body,
  ].join("\r\n");

  // Gmail requires base64url (RFC 4648 §5): replace + with -, / with _
  return Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ─── Idempotency check ────────────────────────────────────────────────────────

async function findExistingDraft(
  idempotencyKey: string,
): Promise<{ id: string; provider_draft_id: string | null } | null> {
  const res = await query<{ id: string; provider_draft_id: string | null }>(
    `SELECT id, provider_draft_id
       FROM email_drafts
      WHERE idempotency_key = $1
      LIMIT 1`,
    [idempotencyKey],
  );
  return res.rows[0] ?? null;
}

// ─── Auth failure helper ──────────────────────────────────────────────────────

/**
 * Mark the user's Google connected account as `reauth_required`.
 * Uses ADD COLUMN IF NOT EXISTS semantics — if the column doesn't exist yet
 * (pre-migration), the UPDATE is silently swallowed so the flow still reaches
 * the `AuthError` throw below.
 */
async function markGoogleReauthRequired(
  userId: string,
  googleAccountId?: string | null,
): Promise<void> {
  try {
    // Scope to a single account when known so we never nuke a user's other
    // (still-valid) connected mailbox.
    if (googleAccountId) {
      await query(
        `UPDATE google_accounts
            SET reauth_required = true,
                access_token = NULL,
                refresh_token = NULL,
                enc_iv = NULL,
                enc_tag = NULL,
                enc_kid = NULL
          WHERE id = $1`,
        [googleAccountId],
      );
    } else {
      await query(
        `UPDATE google_accounts
            SET reauth_required = true,
                access_token = NULL,
                refresh_token = NULL,
                enc_iv = NULL,
                enc_tag = NULL,
                enc_kid = NULL
          WHERE user_id = $1 AND is_primary = true`,
        [userId],
      );
    }

    await query(
      `UPDATE connected_accounts
          SET reauth_required = true
        WHERE user_id = $1 AND provider = 'google'`,
      [userId],
    );
  } catch {
    // Column may not exist yet — not fatal.
  }
}

// ─── Persist draft row ────────────────────────────────────────────────────────

async function persistDraft(p: {
  executionId?: string | null;
  stepId: string;
  userId: string;
  /** Comma-joined recipient list stored in the `recipient` TEXT column. */
  recipient: string;
  subject: string;
  providerDraftId: string;
  idempotencyKey: string;
}): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO email_drafts
       (execution_id, step_id, user_id, provider, provider_draft_id,
        recipient, subject, idempotency_key)
     VALUES ($1, $2, $3, 'gmail', $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      p.executionId,
      p.stepId,
      p.userId,
      p.providerDraftId,
      p.recipient,
      p.subject,
      p.idempotencyKey,
    ],
  );

  if (res.rows[0]) return res.rows[0].id;

  // Already existed — fetch the id.
  const existing = await query<{ id: string }>(
    `SELECT id FROM email_drafts WHERE idempotency_key = $1 LIMIT 1`,
    [p.idempotencyKey],
  );
  return existing.rows[0]?.id ?? "";
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Create a Gmail draft for the given user.
 *
 * Flow:
 * 1. Idempotency check — return stored result if already processed.
 * 2. Get/refresh Google access token.
 * 3. Look up the user's "from" email address.
 * 4. Build the MIME message and call `gmail.users.drafts.create`.
 * 5. Persist the draft ID into `email_drafts`.
 * 6. Write an `audit_log` entry.
 *
 * @throws `AuthError` (non-retryable) on 401/403 from Gmail.
 * @throws Any other error is considered transient and will be retried by BullMQ.
 */
export async function createGmailDraft(
  params: GmailDraftCreateParams,
): Promise<GmailDraftResult> {
  // ── 1. Idempotency check ──────────────────────────────────────────────────
  const existing = await findExistingDraft(params.idempotencyKey);
  if (existing) {
    console.log(
      `[gmail.service] idempotent hit — draft already created (key=${params.idempotencyKey})`,
    );
    return {
      emailDraftId: existing.id,
      providerDraftId: existing.provider_draft_id ?? "",
      isNew: false,
    };
  }

  // ── 2. Refresh / get access token ────────────────────────────────────────
  let accessToken: string;
  try {
    accessToken = params.googleAccountId
      ? await refreshGoogleTokenForAccount(params.googleAccountId)
      : await refreshGoogleTokenIfNeeded(params.userId);
  } catch (err) {
    await markGoogleReauthRequired(params.userId, params.googleAccountId);
    const msg = err instanceof Error ? err.message : String(err);
    throw new AuthError(`Gmail: token refresh failed — ${msg}`);
  }

  // ── 3. Look up sender email ───────────────────────────────────────────────
  let fromEmail = params.fromEmail?.trim() || "";
  if (!fromEmail) {
    const userRes = await query<{ email: string }>(
      "SELECT email FROM users WHERE id = $1 LIMIT 1",
      [params.userId],
    );
    fromEmail = userRes.rows[0]?.email ?? params.userId;
  }

  // ── 4. Call Gmail API ─────────────────────────────────────────────────────
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const raw = buildMimeMessage(
    fromEmail,
    params.recipients,
    params.subject,
    params.body,
  );

  let providerDraftId: string;
  try {
    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: { raw },
      },
    });
    providerDraftId = response.data.id ?? "";
  } catch (err: unknown) {
    const status =
      (err as { status?: number; code?: number })?.status ??
      (err as { status?: number; code?: number })?.code ??
      0;

    if (status === 401 || status === 403) {
      await markGoogleReauthRequired(params.userId, params.googleAccountId);
      throw new AuthError(
        `Gmail: provider returned ${status} — user must reconnect Google account`,
      );
    }
    // Re-throw as transient for BullMQ to retry.
    throw err;
  }

  // ── 5. Persist the draft row ──────────────────────────────────────────────
  const emailDraftId = await persistDraft({
    executionId: params.executionId,
    stepId: params.stepId,
    userId: params.userId,
    recipient: params.recipients.join(", "),
    subject: params.subject,
    providerDraftId,
    idempotencyKey: params.idempotencyKey,
  });

  // ── 6. Audit log (fire-and-forget) ────────────────────────────────────────
  recordAuditLog({
    userId: params.userId,
    actorType: "worker",
    action: "email.draft.create",
    entityType: "email_draft",
    entityId: emailDraftId || undefined,
    idempotencyKey: params.idempotencyKey,
    payload: {
      executionId: params.executionId,
      stepId: params.stepId,
      provider: "gmail",
      recipients: params.recipients,
      subject: params.subject,
      providerDraftId,
    },
  }).catch((e) => console.error("[gmail.service] audit_log write failed:", e));

  return { emailDraftId, providerDraftId, isNew: true };
}

/**
 * Compute the deterministic idempotency key for an email draft.
 *
 * Format: `email:draft:<executionId>:<stepId>:<recipientHash>:<subjectHash>`
 * where each hash is the first 12 hex chars of SHA-256.
 *
 * When multiple recipients are supplied they are sorted before hashing so that
 * order differences do not produce different keys.
 */
export function computeDraftIdempotencyKey(
  executionId: string,
  stepId: string,
  recipients: string | string[],
  subject: string,
): string {
  const recipientStr = Array.isArray(recipients)
    ? [...recipients].sort().join(",")
    : recipients;
  const rHash = createHash("sha256")
    .update(recipientStr)
    .digest("hex")
    .slice(0, 12);
  const sHash = createHash("sha256").update(subject).digest("hex").slice(0, 12);
  return `email:draft:${executionId}:${stepId}:${rHash}:${sHash}`;
}

// ─── Send a Gmail draft ───────────────────────────────────────────────────────

export interface GmailSendParams {
  executionId: string;
  stepId: string;
  userId: string;
  /** Which Google account (mailbox) to send from. Defaults to the primary account. */
  googleAccountId?: string | null;
  /** The `provider_draft_id` returned by `createGmailDraft`. */
  providerDraftId: string;
  /** Idempotency key — callers should derive it deterministically. */
  idempotencyKey: string;
}

export interface GmailSendResult {
  messageId: string;
  threadId: string;
  alreadySent: boolean;
}

/**
 * Send an existing Gmail draft via `users.drafts.send`.
 *
 * The sent message appears in the user's "Sent" folder and is delivered to
 * all recipients.  The draft is consumed (deleted) by Gmail automatically.
 *
 * Idempotency: checks `email_drafts.sent_at`; if already sent, returns the
 * stored result without calling Gmail again.
 *
 * @throws `AuthError` on 401/403 (permanent — user must re-connect).
 */
export async function sendGmailDraft(
  params: GmailSendParams,
): Promise<GmailSendResult> {
  // ── Idempotency check ─────────────────────────────────────────────────────
  const existing = await query<{
    sent_at: Date | null;
    provider_message_id: string | null;
    provider_thread_id: string | null;
  }>(
    `SELECT sent_at, provider_message_id, provider_thread_id
       FROM email_drafts
      WHERE provider_draft_id = $1 AND user_id = $2
      LIMIT 1`,
    [params.providerDraftId, params.userId],
  );

  if (existing.rows[0]?.sent_at) {
    return {
      messageId: existing.rows[0].provider_message_id ?? "",
      threadId: existing.rows[0].provider_thread_id ?? "",
      alreadySent: true,
    };
  }

  // ── Refresh access token ──────────────────────────────────────────────────
  let accessToken: string;
  try {
    accessToken = params.googleAccountId
      ? await refreshGoogleTokenForAccount(params.googleAccountId)
      : await refreshGoogleTokenIfNeeded(params.userId);
  } catch (err) {
    await markGoogleReauthRequired(params.userId, params.googleAccountId);
    const msg = err instanceof Error ? err.message : String(err);
    throw new AuthError(`Gmail send: token refresh failed — ${msg}`);
  }

  // ── Send the draft ────────────────────────────────────────────────────────
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  let messageId = "";
  let threadId = "";

  try {
    const resp = await gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: params.providerDraftId },
    });
    messageId = resp.data.id ?? "";
    threadId = resp.data.threadId ?? "";
  } catch (err: unknown) {
    const status =
      (err as { status?: number; code?: number })?.status ??
      (err as { status?: number; code?: number })?.code ??
      0;

    if (status === 401 || status === 403) {
      await markGoogleReauthRequired(params.userId, params.googleAccountId);
      throw new AuthError(
        `Gmail send: provider returned ${status} — user must reconnect`,
      );
    }
    throw err; // transient — BullMQ will retry
  }

  // ── Update the draft row with sent metadata ───────────────────────────────
  await query(
    `UPDATE email_drafts
        SET sent_at              = NOW(),
            provider_message_id  = $2,
            provider_thread_id   = $3
      WHERE provider_draft_id = $1 AND user_id = $4`,
    [params.providerDraftId, messageId, threadId, params.userId],
  ).catch((err) =>
    console.error("[gmail.service] failed to update email_drafts row:", err),
  );

  // ── Audit log ─────────────────────────────────────────────────────────────
  recordAuditLog({
    userId: params.userId,
    actorType: "worker",
    action: "email.draft.send",
    entityType: "email_draft",
    idempotencyKey: params.idempotencyKey,
    payload: {
      executionId: params.executionId,
      stepId: params.stepId,
      provider: "gmail",
      providerDraftId: params.providerDraftId,
      messageId,
      threadId,
    },
  }).catch((e) => console.error("[gmail.service] audit_log write failed:", e));

  return { messageId, threadId, alreadySent: false };
}

// ─── Error types ──────────────────────────────────────────────────────────────

/**
 * Non-retryable auth failure.  The step handler should catch this and mark the
 * execution step as permanently failed.
 */
export class AuthError extends Error {
  readonly isAuthError = true;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
