import { createHash, randomUUID } from "crypto";
import { AuthError, createGmailDraft, sendGmailDraft } from "./gmail.service";
import {
  getEmailTemplateById,
  getEffectiveDeclineTemplate,
} from "./templates.service";
import { createEmailSendLog } from "./sendLogs.service";
import { upsertAttendanceResponse } from "../attendanceResponses.service";
import { getEventById } from "../events.service";
import { declineGoogleEvent } from "../calendar/google";
import { AppUser } from "../../types";
import { BadRequestError, NotFoundError } from "../../utils/errors";

export interface SendDeclineEmailParams {
  user: AppUser;
  eventId: string;
  templateId?: string;
  customSubject?: string;
  customBody?: string;
  sendToOrganizer?: boolean;
  sendToAttendees?: boolean;
}

export interface SendDeclineEmailResult {
  sendLogId: string;
  eventSuppressed: boolean;
  status: "sent" | "already_sent";
  provider: "gmail";
  eventId: string;
  recipients: string[];
  subject: string;
  body: string;
  messageId: string;
  threadId: string;
  draftId: string;
  providerDraftId: string;
  template: {
    source: "custom" | "system";
    id?: string;
    name: string;
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function resolveRecipients(params: {
  userEmail: string;
  organizerEmail: string | null;
  attendees: { email: string }[];
  sendToOrganizer: boolean;
  sendToAttendees: boolean;
}): string[] {
  const {
    userEmail,
    organizerEmail,
    attendees,
    sendToOrganizer,
    sendToAttendees,
  } = params;

  const deduped = new Set<string>();
  const userEmailNorm = normalizeEmail(userEmail);

  if (sendToOrganizer && organizerEmail) {
    const organizer = normalizeEmail(organizerEmail);
    if (organizer && organizer !== userEmailNorm) {
      deduped.add(organizer);
    }
  }

  if (sendToAttendees) {
    for (const attendee of attendees) {
      const attendeeEmail = normalizeEmail(attendee.email || "");
      if (!attendeeEmail || attendeeEmail === userEmailNorm) continue;
      deduped.add(attendeeEmail);
    }
  }

  return [...deduped];
}

function deriveOrganizerName(organizerEmail: string | null): string {
  if (!organizerEmail) return '';
  const local = organizerEmail.split('@')[0] ?? '';
  const parts = local.split(/[._+-]/).filter(Boolean);
  if (!parts.length) return organizerEmail;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function normalizeTemplateToken(raw: string): string {
  return raw.replace(/[\s._-]+/g, '').toLowerCase();
}

function renderTemplate(
  content: string,
  context: {
    eventTitle: string;
    eventLocation: string;
    eventStartIso: string;
    eventEndIso: string;
    organizerEmail: string | null;
  },
): string {
  const startDate = new Date(context.eventStartIso);
  const humanDate = Number.isFinite(startDate.getTime())
    ? startDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : context.eventStartIso;
  const humanTime = Number.isFinite(startDate.getTime())
    ? startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : context.eventStartIso;
  const organizerName = deriveOrganizerName(context.organizerEmail);

  const tokenValues: Record<string, string> = {
    eventtitle: context.eventTitle,
    title: context.eventTitle,
    eventlocation: context.eventLocation,
    location: context.eventLocation,
    eventstart: context.eventStartIso,
    start: context.eventStartIso,
    eventend: context.eventEndIso,
    end: context.eventEndIso,
    organizername: organizerName,
    organizer: organizerName,
    organizeremail: context.organizerEmail ?? '',
    starttime: humanTime,
    time: humanTime,
    date: humanDate,
    eventdate: humanDate,
  };

  return content.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (full, token: string) => {
    const normalized = normalizeTemplateToken(token);
    return Object.prototype.hasOwnProperty.call(tokenValues, normalized)
      ? tokenValues[normalized]
      : full;
  });
}

function computeDeclineDraftIdempotencyKey(params: {
  userId: string;
  eventId: string;
  recipients: string[];
  subject: string;
  body: string;
}): string {
  const recipientsHash = createHash("sha256")
    .update(params.recipients.join(","))
    .digest("hex")
    .slice(0, 12);

  const subjectHash = createHash("sha256")
    .update(params.subject)
    .digest("hex")
    .slice(0, 12);

  const bodyHash = createHash("sha256")
    .update(params.body)
    .digest("hex")
    .slice(0, 12);

  return `decline:draft:${params.userId}:${params.eventId}:${recipientsHash}:${subjectHash}:${bodyHash}`;
}

export async function sendDeclineEmailForEvent(
  params: SendDeclineEmailParams,
): Promise<SendDeclineEmailResult> {
  const {
    user,
    eventId,
    templateId,
    customSubject,
    customBody,
    sendToOrganizer = true,
    sendToAttendees = true,
  } = params;

  const event = await getEventById(user.id, eventId);
  if (!event) {
    throw new NotFoundError("Event");
  }

  const metadata =
    event.metadata && typeof event.metadata === "object"
      ? (event.metadata as Record<string, unknown>)
      : {};
  const sourceCalendarId =
    typeof metadata.calendarId === "string" && metadata.calendarId.trim()
      ? metadata.calendarId.trim()
      : "primary";

  const recipients = resolveRecipients({
    userEmail: user.email,
    organizerEmail: event.organizerEmail,
    attendees: event.attendees,
    sendToOrganizer,
    sendToAttendees,
  });

  if (recipients.length === 0) {
    throw new BadRequestError(
      "No recipients found. Enable organizer and/or attendee recipients.",
    );
  }

  let templateSource: "custom" | "system" = "system";
  let templateName = "System Default";
  let selectedTemplateId: string | undefined;
  let subjectTemplate = "";
  let bodyTemplate = "";

  if (templateId) {
    const selected = await getEmailTemplateById(user.id, templateId);
    if (!selected) {
      throw new NotFoundError("Email template");
    }
    templateSource = templateId === "system-default" ? "system" : "custom";
    templateName = selected.name;
    selectedTemplateId = selected.id;
    subjectTemplate = selected.subjectTemplate;
    bodyTemplate = selected.bodyTemplate;
  } else {
    const effective = await getEffectiveDeclineTemplate(user.id);
    templateSource = effective.source;
    templateName = effective.template.name;
    selectedTemplateId = effective.template.id;
    subjectTemplate = effective.template.subjectTemplate;
    bodyTemplate = effective.template.bodyTemplate;
  }

  const renderContext = {
    eventTitle: event.title,
    eventLocation: event.location ?? "",
    eventStartIso: event.startTime.toISOString(),
    eventEndIso: event.endTime.toISOString(),
    organizerEmail: event.organizerEmail ?? null,
  };

  const renderedSubject = customSubject?.trim().length
    ? customSubject.trim()
    : renderTemplate(subjectTemplate, renderContext);

  const renderedBody = customBody?.trim().length
    ? customBody.trim()
    : renderTemplate(bodyTemplate, renderContext);

  const draftIdempotencyKey = computeDeclineDraftIdempotencyKey({
    userId: user.id,
    eventId,
    recipients,
    subject: renderedSubject,
    body: renderedBody,
  });

  let sendCompleted = false;

  try {
    await declineGoogleEvent(
      user.id,
      user.email,
      event.externalEventId,
      sourceCalendarId,
    );

    const draft = await createGmailDraft({
      executionId: null,
      stepId: `decline_email:${eventId}`,
      userId: user.id,
      recipients,
      subject: renderedSubject,
      body: renderedBody,
      idempotencyKey: draftIdempotencyKey,
    });

    const sendResult = await sendGmailDraft({
      executionId: `decline:${eventId}`,
      stepId: `decline_email:${eventId}`,
      userId: user.id,
      providerDraftId: draft.providerDraftId,
      idempotencyKey: `decline:send:${user.id}:${eventId}:${randomUUID()}`,
    });
    sendCompleted = true;

    const sendLog = await createEmailSendLog({
      userId: user.id,
      eventId,
      templateId: selectedTemplateId ?? null,
      recipients,
      subject: renderedSubject,
      body: renderedBody,
      status: sendResult.alreadySent ? "already_sent" : "sent",
      gmailMessageId: sendResult.messageId || null,
      failureReason: null,
    });

    await upsertAttendanceResponse({
      userId: user.id,
      eventId,
      response: "no",
    });

    return {
      sendLogId: sendLog.id,
      eventSuppressed: false,
      status: sendResult.alreadySent ? "already_sent" : "sent",
      provider: "gmail",
      eventId,
      recipients,
      subject: renderedSubject,
      body: renderedBody,
      messageId: sendResult.messageId,
      threadId: sendResult.threadId,
      draftId: draft.emailDraftId,
      providerDraftId: draft.providerDraftId,
      template: {
        source: templateSource,
        id: selectedTemplateId,
        name: templateName,
      },
    };
  } catch (error) {
    const failureReason =
      error instanceof Error ? error.message : String(error);

    if (!sendCompleted) {
      await createEmailSendLog({
        userId: user.id,
        eventId,
        templateId: selectedTemplateId ?? null,
        recipients,
        subject: renderedSubject,
        body: renderedBody,
        status: "failed",
        gmailMessageId: null,
        failureReason,
      }).catch(() => {});
    }

    throw error;
  }
}

export { AuthError };
