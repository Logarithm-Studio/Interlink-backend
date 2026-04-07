/**
 * Email fallback service for notifications.
 *
 * When FCM push delivery is unavailable (device not registered, FCM not configured,
 * or delivery failure), this service sends a plain-text email to the user via the
 * existing Gmail draft/send mechanism.
 *
 * It reuses `gmail.service.ts` from Step 16, specifically `createGmailDraft` and
 * `computeDraftIdempotencyKey`, so it is idempotent — duplicate BullMQ retries
 * will not create duplicate drafts.
 */

import {
  createGmailDraft,
  computeDraftIdempotencyKey,
} from "../email/gmail.service";
import type { PushAction } from "./push.service";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface EmailFallbackParams {
  executionId: string;
  stepId: string;
  /** Target user's email address. */
  toEmail: string;
  /** ID of the Google Account used as the sender (matches connected_accounts). */
  userId: string;
  title: string;
  body: string;
  /** Already-signed actions from push.service / notification.service. */
  actions: PushAction[];
  /** Base URL used to build action links (e.g. https://app.interlink.com). */
  appBaseUrl?: string;
}

export interface EmailFallbackResult {
  sent: boolean;
  draftId?: string;
  reason?: "gmail_not_configured" | "gmail_error";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildEmailBody(
  title: string,
  body: string,
  actions: PushAction[],
  appBaseUrl: string,
): string {
  const lines: string[] = [title, "", body, ""];

  if (actions.length > 0) {
    lines.push("Actions:");
    for (const action of actions) {
      // Deep link format — the client app resolves the token parameter.
      const link = `${appBaseUrl}/action?token=${encodeURIComponent(action.token)}`;
      lines.push(`  • ${action.label}  →  ${link}`);
    }
    lines.push("");
  }

  lines.push(
    "This notification was sent by Interlink.",
    "If you did not expect this email, you can safely ignore it.",
  );

  return lines.join("\n");
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Send a notification via email as a Gmail draft.
 *
 * Uses the existing Gmail service; idempotent via `computeDraftIdempotencyKey`.
 */
export async function sendEmailFallback(
  params: EmailFallbackParams,
): Promise<EmailFallbackResult> {
  const {
    executionId,
    stepId,
    toEmail,
    userId,
    title,
    body,
    actions,
    appBaseUrl = process.env.APP_BASE_URL ?? "https://app.interlink.com",
  } = params;

  const subject = `Action required: ${title}`;
  const emailBody = buildEmailBody(title, body, actions, appBaseUrl);

  const idempotencyKey = computeDraftIdempotencyKey(
    executionId,
    stepId,
    [toEmail],
    `fallback:${title}`,
  );

  try {
    const result = await createGmailDraft({
      executionId,
      stepId,
      userId,
      recipients: [toEmail],
      subject,
      body: emailBody,
      idempotencyKey,
    });

    return { sent: true, draftId: result.providerDraftId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("not_configured") ||
      message.includes("No Gmail account")
    ) {
      console.log(
        `[emailFallback] Gmail not configured for user=${userId}: ${message}`,
      );
      return { sent: false, reason: "gmail_not_configured" };
    }
    console.error(`[emailFallback] Failed to create Gmail draft:`, err);
    return { sent: false, reason: "gmail_error" };
  }
}
