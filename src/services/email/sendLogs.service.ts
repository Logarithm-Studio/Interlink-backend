import { query } from "../../config/db";

export type EmailSendLogStatus = "sent" | "already_sent" | "failed";

export interface EmailSendLog {
  id: string;
  userId: string;
  eventId: string;
  templateId: string | null;
  recipients: string[];
  subject: string;
  body: string;
  status: EmailSendLogStatus;
  gmailMessageId: string | null;
  failureReason: string | null;
  createdAt: Date;
}

interface EmailSendLogRow {
  id: string;
  user_id: string;
  event_id: string;
  template_id: string | null;
  recipients: unknown;
  subject: string;
  body: string;
  status: EmailSendLogStatus;
  gmail_message_id: string | null;
  failure_reason: string | null;
  created_at: Date;
}

function mapRow(row: EmailSendLogRow): EmailSendLog {
  const recipients = Array.isArray(row.recipients)
    ? (row.recipients as string[])
    : [];

  return {
    id: row.id,
    userId: row.user_id,
    eventId: row.event_id,
    templateId: row.template_id,
    recipients,
    subject: row.subject,
    body: row.body,
    status: row.status,
    gmailMessageId: row.gmail_message_id,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

export async function createEmailSendLog(params: {
  userId: string;
  eventId: string;
  templateId?: string | null;
  recipients: string[];
  subject: string;
  body: string;
  status: EmailSendLogStatus;
  gmailMessageId?: string | null;
  failureReason?: string | null;
}): Promise<EmailSendLog> {
  const result = await query<EmailSendLogRow>(
    `INSERT INTO email_send_logs
       (user_id, event_id, template_id, recipients, subject, body, status, gmail_message_id, failure_reason)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
     RETURNING id, user_id, event_id, template_id, recipients, subject, body,
               status, gmail_message_id, failure_reason, created_at`,
    [
      params.userId,
      params.eventId,
      params.templateId ?? null,
      JSON.stringify(params.recipients),
      params.subject,
      params.body,
      params.status,
      params.gmailMessageId ?? null,
      params.failureReason ?? null,
    ],
  );

  return mapRow(result.rows[0]);
}

export async function listEmailSendLogsForEvent(
  userId: string,
  eventId: string,
): Promise<EmailSendLog[]> {
  const result = await query<EmailSendLogRow>(
    `SELECT id, user_id, event_id, template_id, recipients, subject, body,
            status, gmail_message_id, failure_reason, created_at
       FROM email_send_logs
      WHERE user_id = $1 AND event_id = $2
      ORDER BY created_at DESC`,
    [userId, eventId],
  );

  return result.rows.map(mapRow);
}
