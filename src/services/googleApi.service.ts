import { google, gmail_v1 } from "googleapis";
import {
  refreshGoogleTokenIfNeeded,
  refreshGoogleTokenForAccount,
} from "./auth.service";
import { BadRequestError } from "../utils/errors";

async function getGoogleOAuthClient(
  userId: string,
  googleAccountId?: string | null,
) {
  const accessToken = googleAccountId
    ? await refreshGoogleTokenForAccount(googleAccountId)
    : await refreshGoogleTokenIfNeeded(userId);
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

export async function listGoogleCalendarEvents(params: {
  userId: string;
  googleAccountId?: string | null;
  calendarId?: string;
  maxResults?: number;
  timeMin?: string;
}): Promise<
  Array<{
    id: string | null | undefined;
    status: string | null | undefined;
    summary: string | null | undefined;
    start: string | null | undefined;
    end: string | null | undefined;
    htmlLink: string | null | undefined;
  }>
> {
  const oauth2Client = await getGoogleOAuthClient(
    params.userId,
    params.googleAccountId,
  );
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const response = await calendar.events.list({
    calendarId: params.calendarId ?? "primary",
    maxResults: Math.min(Math.max(params.maxResults ?? 10, 1), 50),
    singleEvents: true,
    orderBy: "startTime",
    timeMin: params.timeMin ?? new Date().toISOString(),
  });

  return (response.data.items ?? []).map((event) => ({
    id: event.id,
    status: event.status,
    summary: event.summary,
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    htmlLink: event.htmlLink,
  }));
}

export type GmailMailbox = "inbox" | "sent" | "all";

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
  messageIdHeader: string | null;
  snippet: string | null;
  internalDate: string | null;
  labelIds: string[];
  attachments: GmailAttachmentSummary[];
}

export interface GmailMessageDetail extends GmailMessageSummary {
  cc: string | null;
  bcc: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  allLinks: string[];
  calendarLinks: string[];
  webLink: string;
}

export interface GmailAttachmentSummary {
  attachmentId: string | null;
  filename: string;
  mimeType: string | null;
  size: number | null;
}

export interface GmailMailboxMessagesResult {
  messages: GmailMessageSummary[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

function mailboxToLabelIds(mailbox: GmailMailbox): string[] | undefined {
  switch (mailbox) {
    case "inbox":
      return ["INBOX"];
    case "sent":
      return ["SENT"];
    case "all":
      return undefined;
    default:
      return undefined;
  }
}

function readHeader(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string | null {
  return (
    headers?.find(
      (header) => header.name?.toLowerCase() === name.toLowerCase(),
    )?.value ?? null
  );
}

function decodeBase64Url(data: string | null | undefined): string | null {
  if (!data) {
    return null;
  }

  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function extractMimeBodies(
  part: gmail_v1.Schema$MessagePart | null | undefined,
  buckets: { text: string[]; html: string[]; calendar: string[] },
): void {
  if (!part) return;

  const mimeType = (part.mimeType ?? "").toLowerCase();
  const decoded = decodeBase64Url(part.body?.data);

  if (decoded) {
    if (mimeType.startsWith("text/plain")) {
      buckets.text.push(decoded);
    } else if (mimeType.startsWith("text/html")) {
      buckets.html.push(decoded);
    } else if (mimeType.startsWith("text/calendar")) {
      buckets.calendar.push(decoded);
    }
  }

  for (const child of part.parts ?? []) {
    extractMimeBodies(child, buckets);
  }
}

function extractAttachments(
  part: gmail_v1.Schema$MessagePart | null | undefined,
  attachments: GmailAttachmentSummary[] = [],
): GmailAttachmentSummary[] {
  if (!part) return attachments;

  const filename = part.filename?.trim();
  const attachmentId = part.body?.attachmentId ?? null;
  if (filename || attachmentId) {
    attachments.push({
      attachmentId,
      filename: filename || "Attachment",
      mimeType: part.mimeType ?? null,
      size: typeof part.body?.size === "number" ? part.body.size : null,
    });
  }

  for (const child of part.parts ?? []) {
    extractAttachments(child, attachments);
  }

  return attachments;
}

function normalizeUrl(url: string): string {
  return url.replace(/[),.;!?]+$/g, "");
}

function extractLinksFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return matches.map(normalizeUrl);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isCalendarLink(url: string): boolean {
  return /(calendar\.google\.com|google\.com\/calendar|event\?eid=|meet\.google\.com|\.ics($|[?#]))/i.test(
    url,
  );
}

function buildGmailWebLink(messageId: string, labelIds: string[]): string {
  const section = labelIds.includes("SENT")
    ? "sent"
    : labelIds.includes("INBOX")
      ? "inbox"
      : "all";

  return `https://mail.google.com/mail/u/0/#${section}/${messageId}`;
}

function encodeRawMime(mime: string): string {
  return Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface MailAttachment {
  filename: string;
  mimeType: string;
  /** File bytes, base64-encoded. */
  base64: string;
}

function buildMimeMessage(params: {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyToMessageId?: string;
  attachments?: MailAttachment[];
}): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(params.subject).toString("base64")}?=`;

  const headers = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
  ];
  if (params.inReplyToMessageId) {
    headers.push(`In-Reply-To: ${params.inReplyToMessageId}`);
    headers.push(`References: ${params.inReplyToMessageId}`);
  }

  const attachments = (params.attachments ?? []).filter((a) => a.base64);
  if (attachments.length === 0) {
    return [
      ...headers,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      params.body,
    ].join("\r\n");
  }

  // multipart/mixed: the text body + each file as a base64 attachment part.
  const boundary = `=_Interlink_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    params.body,
  ];
  for (const a of attachments) {
    const safeName = a.filename.replace(/["\\\r\n]/g, "").trim() || "attachment";
    // RFC 2045 requires base64 wrapped at <=76 chars per line.
    const wrapped = a.base64.replace(/(.{76})/g, "$1\r\n").trimEnd();
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.mimeType}; name="${safeName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${safeName}"`,
      "",
      wrapped,
    );
  }
  parts.push(`--${boundary}--`);
  return parts.join("\r\n");
}

export async function listGmailMailboxMessages(params: {
  userId: string;
  googleAccountId?: string | null;
  mailbox?: GmailMailbox;
  maxResults?: number;
  query?: string;
  pageToken?: string;
}): Promise<GmailMailboxMessagesResult> {
  const mailbox = params.mailbox ?? "inbox";
  const labelIds = mailboxToLabelIds(mailbox);

  const oauth2Client = await getGoogleOAuthClient(
    params.userId,
    params.googleAccountId,
  );
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds,
    maxResults: Math.min(Math.max(params.maxResults ?? 20, 1), 50),
    q: params.query,
    pageToken: params.pageToken,
  });

  const messageRefs = listResponse.data.messages ?? [];

  const hydrated = await Promise.all(
    messageRefs
      .filter((message) => message.id && message.threadId)
      .map(async (message): Promise<GmailMessageSummary> => {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: message.id!,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date", "Message-ID"],
        });

        const headers = detail.data.payload?.headers;

        return {
          id: message.id!,
          threadId: message.threadId!,
          from: readHeader(headers, "From"),
          to: readHeader(headers, "To"),
          subject: readHeader(headers, "Subject"),
          date: readHeader(headers, "Date"),
          messageIdHeader: readHeader(headers, "Message-ID"),
          snippet: detail.data.snippet ?? null,
          internalDate: detail.data.internalDate ?? null,
          labelIds: detail.data.labelIds ?? [],
          attachments: extractAttachments(detail.data.payload),
        };
      }),
  );

  return {
    messages: hydrated,
    nextPageToken: listResponse.data.nextPageToken ?? undefined,
    resultSizeEstimate: listResponse.data.resultSizeEstimate ?? undefined,
  };
}

export async function getGmailMessageDetail(params: {
  userId: string;
  googleAccountId?: string | null;
  messageId: string;
}): Promise<GmailMessageDetail> {
  const oauth2Client = await getGoogleOAuthClient(
    params.userId,
    params.googleAccountId,
  );
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const detail = await gmail.users.messages.get({
    userId: "me",
    id: params.messageId,
    format: "full",
  });

  if (!detail.data.id || !detail.data.threadId) {
    throw new BadRequestError("Gmail message could not be loaded.");
  }

  const headers = detail.data.payload?.headers;
  const buckets = { text: [] as string[], html: [] as string[], calendar: [] as string[] };
  extractMimeBodies(detail.data.payload, buckets);

  const bodyText = buckets.text.join("\n\n").trim() || null;
  const bodyHtml = buckets.html.join("\n").trim() || null;

  const allLinks = dedupeStrings([
    ...extractLinksFromText(bodyText),
    ...extractLinksFromText(bodyHtml),
    ...extractLinksFromText(buckets.calendar.join("\n")),
    ...extractLinksFromText(detail.data.snippet ?? null),
  ]);

  const calendarLinks = allLinks.filter(isCalendarLink);
  const labelIds = detail.data.labelIds ?? [];

  return {
    id: detail.data.id,
    threadId: detail.data.threadId,
    from: readHeader(headers, "From"),
    to: readHeader(headers, "To"),
    cc: readHeader(headers, "Cc"),
    bcc: readHeader(headers, "Bcc"),
    subject: readHeader(headers, "Subject"),
    date: readHeader(headers, "Date"),
    messageIdHeader: readHeader(headers, "Message-ID"),
    snippet: detail.data.snippet ?? null,
    internalDate: detail.data.internalDate ?? null,
    labelIds,
    attachments: extractAttachments(detail.data.payload),
    bodyText,
    bodyHtml,
    allLinks,
    calendarLinks,
    webLink: buildGmailWebLink(detail.data.id, labelIds),
  };
}

export async function sendAutomatedGmailMessage(params: {
  userId: string;
  googleAccountId?: string | null;
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyToMessageId?: string;
  attachments?: MailAttachment[];
}): Promise<{
  id: string;
  threadId: string;
  labelIds: string[];
}> {
  if (!params.toEmail.trim()) {
    throw new BadRequestError("Recipient email is required");
  }

  if (!params.subject.trim() || !params.body.trim()) {
    throw new BadRequestError("Subject and body are required");
  }

  const oauth2Client = await getGoogleOAuthClient(
    params.userId,
    params.googleAccountId,
  );
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const mime = buildMimeMessage({
    from: params.fromEmail,
    to: params.toEmail,
    subject: params.subject,
    body: params.body,
    inReplyToMessageId: params.inReplyToMessageId,
    attachments: params.attachments,
  });

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodeRawMime(mime),
      threadId: params.threadId,
    },
  });

  if (!response.data.id || !response.data.threadId) {
    throw new BadRequestError("Gmail did not return message identifiers");
  }

  return {
    id: response.data.id,
    threadId: response.data.threadId,
    labelIds: response.data.labelIds ?? [],
  };
}

export async function listGmailInboxMessages(params: {
  userId: string;
  googleAccountId?: string | null;
  maxResults?: number;
  query?: string;
}): Promise<GmailMessageSummary[]> {
  const result = await listGmailMailboxMessages({
    userId: params.userId,
    googleAccountId: params.googleAccountId,
    mailbox: "inbox",
    maxResults: params.maxResults,
    query: params.query,
  });
  return result.messages;
}
