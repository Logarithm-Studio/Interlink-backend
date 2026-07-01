/**
 * Generic Gmail send for professional verticals (sales follow-ups, support
 * replies, real-estate lead follow-ups, recruiter outreach, …). Wraps the same
 * create-draft + send-draft pair the accountant dunning flow uses so every
 * profession sends through the user's connected Gmail with idempotency.
 */

import { randomUUID } from "crypto";
import { createGmailDraft, sendGmailDraft } from "../email/gmail.service";
import { AppUser } from "../../types";

export async function sendProfessionalEmail(params: {
  user: AppUser;
  to: string;
  subject: string;
  body: string;
  /** Short stable label for logs/idempotency, e.g. "sales_followup". */
  tag: string;
}): Promise<{ messageId: string }> {
  const draft = await createGmailDraft({
    executionId: null,
    stepId: params.tag,
    userId: params.user.id,
    recipients: [params.to],
    subject: params.subject,
    body: params.body,
    idempotencyKey: `prof:${params.tag}:draft:${params.user.id}:${randomUUID()}`,
  });
  const sendResult = await sendGmailDraft({
    executionId: params.tag,
    stepId: params.tag,
    userId: params.user.id,
    providerDraftId: draft.providerDraftId,
    idempotencyKey: `prof:${params.tag}:send:${params.user.id}:${randomUUID()}`,
  });
  return { messageId: sendResult.messageId };
}
