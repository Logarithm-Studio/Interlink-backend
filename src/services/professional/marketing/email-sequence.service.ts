import { z } from "zod";
import { query } from "../../../config/db";
import { AppError } from "../../../utils/errors";
import { resolveGoogleAccountId, getGoogleAccountSummaryById } from "../../auth.service";
import { getGmailMessageDetail, getGmailThreadMessages, listGmailMailboxMessages, sendAutomatedGmailMessage } from "../../googleApi.service";
import { enqueueJob } from "../../jobQueue.service";
import { getContact } from "../sales/sales.service";

const Step = z.object({ subject: z.string().trim().min(1).max(500), body: z.string().trim().min(1).max(20000), delayDays: z.number().int().min(1).max(30) });
export const SequenceInput = z.object({ contactId: z.string().uuid(), initialMessageId: z.string().min(1).max(300), expectedSenderEmail: z.string().email(), steps: z.array(Step).min(1).max(3), confirmed: z.literal(true) });
type SequenceRow = { id: string; user_id: string; contact_id: string; google_account_id: string; sender_email: string; recipient_email: string; initial_message_id: string; thread_id: string; reply_header: string | null; initial_sent_at: Date; steps: z.infer<typeof Step>[]; next_step: number; due_at: Date; status: string; sent_message_ids: string[]; last_error: string | null };

export async function listEmailSequences(userId: string) {
  return (await query<SequenceRow>("SELECT * FROM sales_marketing_email_sequences WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100", [userId])).rows;
}

export async function createEmailSequence(userId: string, raw: z.infer<typeof SequenceInput>) {
  const input = SequenceInput.parse(raw);
  if (input.steps.some(step => /\[[^\]]+\]/.test(step.subject + step.body))) throw new AppError("Replace template placeholders before approving the sequence.", 400);
  const contact = await getContact(userId, input.contactId);
  if (!contact?.email || !contact.marketingOptIn) throw new AppError("Record this contact's marketing permission before enabling automatic email.", 409);
  const accountId = await resolveGoogleAccountId(userId, "professional");
  const account = accountId ? await getGoogleAccountSummaryById(accountId) : null;
  if (!account?.email || account.reauthRequired || account.email.toLowerCase() !== input.expectedSenderEmail.toLowerCase()) throw new AppError("Review and reconnect the sending mailbox before scheduling.", 409);
  const initial = await getGmailMessageDetail({ userId, googleAccountId: accountId, messageId: input.initialMessageId });
  const recipients: string[] = (initial.to ?? "").toLowerCase().match(/[^\s<>(),;]+@[^\s<>(),;]+/g) ?? [];
  const sentAt = Number(initial.internalDate);
  if (!initial.labelIds.includes("SENT") || !recipients.includes(contact.email.toLowerCase()) || !Number.isFinite(sentAt) || sentAt <= 0 || sentAt > Date.now() + 60000) throw new AppError("Choose a confirmed sent message to this prospect from this mailbox.", 400);
  const saved = await query<SequenceRow>(
    `INSERT INTO sales_marketing_email_sequences(user_id,contact_id,google_account_id,sender_email,recipient_email,initial_message_id,thread_id,reply_header,initial_sent_at,steps,due_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     ON CONFLICT(user_id,initial_message_id) DO NOTHING RETURNING *`,
    [userId, contact.id, accountId, account.email, contact.email, initial.id, initial.threadId, initial.messageIdHeader, new Date(sentAt), JSON.stringify(input.steps), new Date(Date.now() + input.steps[0].delayDays * 86400000)],
  );
  if (!saved.rows[0]) throw new AppError("This message already has an approved sequence. Review its existing status.", 409);
  // Persist first. The hourly dispatcher recovers failed or distant queue submissions.
  await dispatchEmailSequences(new Date(), saved.rows[0].id).catch(() => undefined);
  return saved.rows[0];
}

export async function cancelEmailSequence(userId: string, id: string) {
  const result = await query("UPDATE sales_marketing_email_sequences SET status='cancelled',updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('pending','checking','review') RETURNING id", [id, userId]);
  if (!result.rows.length) throw new AppError("This sequence has finished or a send is already in progress. Refresh its status.", 409);
}

export async function dispatchEmailSequences(now = new Date(), onlyId?: string) {
  await query("UPDATE sales_marketing_email_sequences SET status='review',last_error='Delivery was interrupted; check Gmail before continuing.',updated_at=now() WHERE status='sending' AND updated_at < $1::timestamptz - interval '20 minutes'", [now]);
  await query("UPDATE sales_marketing_email_sequences SET status='pending',updated_at=now() WHERE status='checking' AND updated_at < $1::timestamptz - interval '20 minutes'", [now]);
  const rows = await query<SequenceRow>("SELECT * FROM sales_marketing_email_sequences WHERE status='pending' AND due_at <= $1::timestamptz + interval '6 days' AND ($2::uuid IS NULL OR id=$2) ORDER BY due_at LIMIT 50", [now, onlyId ?? null]);
  for (const row of rows.rows) {
    const key = `marketing-email:${row.id}:${row.next_step}`;
    try { await enqueueJob("marketing-email-sequence", { jobType: "marketing.email.sequence", idempotencyKey: key, userId: row.user_id, payload: { sequenceId: row.id, step: row.next_step } }, { jobId: key, notBefore: row.due_at, retries: 5 }); }
    catch { /* The durable pending row remains available to the next hourly pass. */ }
  }
  return rows.rowCount;
}

export async function runEmailSequence(userId: string, id: string, step: number, now = new Date()) {
  const claimed = await query<SequenceRow>("UPDATE sales_marketing_email_sequences SET status='checking',last_error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND next_step=$3 AND status='pending' AND due_at<=$4 RETURNING *", [id, userId, step, now]);
  const row = claimed.rows[0];
  if (!row) return { skipped: true };
  let message: z.infer<typeof Step>;
  try {
    const contact = await getContact(userId, row.contact_id);
    const account = await getGoogleAccountSummaryById(row.google_account_id);
    if (!contact?.marketingOptIn || contact.email?.toLowerCase() !== row.recipient_email.toLowerCase() || !account?.email || account.reauthRequired || account.email.toLowerCase() !== row.sender_email.toLowerCase()) {
      await query("UPDATE sales_marketing_email_sequences SET status='cancelled',last_error='Permission, prospect address or approved sending account changed.',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='checking'", [id, userId]);
      return { cancelled: true };
    }
    message = Step.parse(row.steps[step]);
    // Any later incoming message from the prospect stops the sequence, including archived replies.
    const [replies,thread] = await Promise.all([
      listGmailMailboxMessages({ userId, googleAccountId: row.google_account_id, mailbox: "all", maxResults: 1, query: `from:${row.recipient_email} after:${Math.floor(new Date(row.initial_sent_at).getTime() / 1000) + 1} -in:sent -in:trash -in:spam` }),
      getGmailThreadMessages({userId,googleAccountId:row.google_account_id,threadId:row.thread_id}),
    ]);
    const incomingInThread=thread.some(message=>!message.labelIds.some(label=>["SENT","DRAFT","TRASH","SPAM"].includes(label))&&Number(message.internalDate)>new Date(row.initial_sent_at).getTime());
    if(thread.some(message=>!message.labelIds.includes("SENT")&&!message.labelIds.includes("DRAFT")&&(!Number.isFinite(Number(message.internalDate))||Number(message.internalDate)<=0)))throw new AppError("Gmail returned incomplete reply metadata; no follow-up was sent.",502);
    if (replies.messages.length || incomingInThread) {
      await query("UPDATE sales_marketing_email_sequences SET status='replied',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='checking'", [id, userId]);
      return { replied: true };
    }
  } catch (error) {
    await query("UPDATE sales_marketing_email_sequences SET status='pending',last_error='Reply checks are unavailable; no follow-up was sent. Reconnect Gmail or cancel waiting messages.',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='checking'", [id, userId]);
    throw error; // A failed read is retryable; no email has been attempted.
  }
  const sending = await query(
    `UPDATE sales_marketing_email_sequences SET status='sending',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='checking'
     AND EXISTS(SELECT 1 FROM sales_contacts WHERE id=$3 AND user_id=$2 AND marketing_opt_in=true AND lower(email)=lower($4)) RETURNING id`,
    [id, userId, row.contact_id, row.recipient_email],
  );
  if (!sending.rows.length) {
    await query("UPDATE sales_marketing_email_sequences SET status='cancelled',last_error='Permission changed before delivery.',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='checking'",[id,userId]);
    return { skipped: true };
  }
  try {
    const sent = await sendAutomatedGmailMessage({ userId, googleAccountId: row.google_account_id, fromEmail: row.sender_email, toEmail: row.recipient_email, subject: message.subject, body: message.body, threadId: row.thread_id, ...(row.reply_header ? { inReplyToMessageId: row.reply_header } : {}) });
    const next = step + 1;
    const done = next >= row.steps.length;
    await query("UPDATE sales_marketing_email_sequences SET status=$3,next_step=$4,sent_message_ids=sent_message_ids || $5::jsonb,due_at=$6,updated_at=now() WHERE id=$1 AND user_id=$2 AND status='sending'", [id, userId, done ? "completed" : "pending", next, JSON.stringify([sent.id]), new Date(now.getTime() + (done ? 0 : row.steps[next].delayDays * 86400000))]);
    return { sent: true, completed: done };
  } catch {
    await query("UPDATE sales_marketing_email_sequences SET status='review',last_error='Gmail delivery was not confirmed. Check the mailbox; this step will not retry automatically.',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='sending'", [id, userId]);
    return { review: true };
  }
}
