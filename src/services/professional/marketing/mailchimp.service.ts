import { AppError } from "../../../utils/errors";
import { executeComposioProxy } from "../../composio/composio.service";

const TOOLKIT = "mailchimp";

function objectData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function request<T>(
  userId: string,
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  body?: unknown,
  parameters?: Array<{ in: "query"; name: string; value: string | number }>,
): Promise<T> {
  const response = await executeComposioProxy(userId, TOOLKIT, endpoint, method, body, parameters);
  if (response.status < 200 || response.status >= 300) {
    const data = objectData(response.data);
    const detail = typeof data.detail === "string" ? data.detail : typeof data.title === "string" ? data.title : "Mailchimp rejected the request.";
    throw new AppError(detail.slice(0, 500), response.status >= 500 ? 502 : 422);
  }
  return response.data as T;
}

export interface MailchimpAudience {
  id: string;
  name: string;
  subscribedCount: number;
  unsubscribedCount: number;
}

export async function listMailchimpAudiences(userId: string): Promise<MailchimpAudience[]> {
  const data = await request<{ lists?: Array<{ id?: string; name?: string; stats?: { member_count?: number; unsubscribe_count?: number } }> }>(
    userId, "/lists", "GET", undefined,
    [{ in: "query", name: "count", value: 100 }, { in: "query", name: "fields", value: "lists.id,lists.name,lists.stats.member_count,lists.stats.unsubscribe_count" }],
  );
  return (data.lists ?? []).filter((list) => list.id).map((list) => ({
    id: list.id!, name: list.name ?? "Untitled audience",
    subscribedCount: list.stats?.member_count ?? 0,
    unsubscribedCount: list.stats?.unsubscribe_count ?? 0,
  }));
}

export interface MailchimpCampaignDraft {
  id: string;
  status: string;
  recipientCount: number;
  checklist: string[];
}

export class MailchimpDraftPartialError extends AppError {
  constructor(public readonly providerCampaignId: string, message: string) {
    super(message, 502);
  }
}

function toHtml(text: string): string {
  return text.split(/\r?\n\s*\r?\n/).map((paragraph) =>
    `<p>${paragraph.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>")}</p>`,
  ).join("\n");
}

export async function createMailchimpCampaignDraft(
  userId: string,
  input: { campaignId: string; topic: string; subject: string; body: string; audienceId: string; fromName: string; replyTo: string },
): Promise<MailchimpCampaignDraft> {
  const created = await request<Record<string, unknown>>(userId, "/campaigns", "POST", {
    type: "regular",
    recipients: { list_id: input.audienceId },
    settings: {
      title: `Interlink ${input.campaignId}`,
      subject_line: input.subject,
      from_name: input.fromName,
      reply_to: input.replyTo,
    },
  });
  const providerId = typeof created.id === "string" ? created.id : "";
  if (!providerId) throw new AppError("Mailchimp created a campaign but returned no campaign ID. Check Mailchimp before retrying.", 502);

  try {
    await request(userId, `/campaigns/${encodeURIComponent(providerId)}/content`, "PUT", {
      html: toHtml(input.body), plain_text: input.body,
    });
    const info = await request<Record<string, unknown>>(userId, `/campaigns/${encodeURIComponent(providerId)}`, "GET");
    const recipients = objectData(info.recipients);
    const recipientCount = typeof recipients.recipient_count === "number" ? recipients.recipient_count : 0;
    const checklist = await getMailchimpChecklist(userId, providerId);
    return { id: providerId, status: typeof info.status === "string" ? info.status : "save", recipientCount, checklist };
  } catch (error) {
    throw new MailchimpDraftPartialError(providerId, `Mailchimp draft ${providerId} exists but Interlink could not finish preparing it. Sync it before sending. ${error instanceof Error ? error.message : ""}`);
  }
}

export async function getMailchimpChecklist(userId: string, providerCampaignId: string): Promise<string[]> {
  const data = await request<Record<string, unknown>>(
    userId, `/campaigns/${encodeURIComponent(providerCampaignId)}/send-checklist`, "GET",
  );
  const items = Array.isArray(data.items) ? data.items : [];
  const issues = items.map(objectData).filter((item) => item.is_ready === false || item.type === "error");
  const messages = issues.map((item) => [item.heading, item.details].filter((part) => typeof part === "string").join(": ")).filter(Boolean) as string[];
  if (data.is_ready === false && messages.length === 0) messages.push("Mailchimp reports that this campaign is not ready to send.");
  return messages;
}

export async function sendMailchimpCampaign(userId: string, providerCampaignId: string): Promise<void> {
  const checklist = await getMailchimpChecklist(userId, providerCampaignId);
  if (checklist.length) throw new AppError(`Mailchimp send checklist needs attention: ${checklist.slice(0, 4).join("; ")}`, 422);
  await request(userId, `/campaigns/${encodeURIComponent(providerCampaignId)}/actions/send`, "POST", {});
}

export async function scheduleMailchimpCampaign(userId: string, providerCampaignId: string, scheduledAt: Date): Promise<void> {
  const checklist = await getMailchimpChecklist(userId, providerCampaignId);
  if (checklist.length) throw new AppError(`Mailchimp send checklist needs attention: ${checklist.slice(0, 4).join("; ")}`, 422);
  await request(userId, `/campaigns/${encodeURIComponent(providerCampaignId)}/actions/schedule`, "POST", {
    schedule_time: scheduledAt.toISOString(),
  });
}

export async function unscheduleMailchimpCampaign(userId: string, providerCampaignId: string): Promise<void> {
  await request(userId, `/campaigns/${encodeURIComponent(providerCampaignId)}/actions/unschedule`, "POST", {});
}

export interface MailchimpCampaignReport {
  emailsSent: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  unsubscribes: number;
  bounces: number;
  openRate: number;
  clickRate: number;
}

export async function getMailchimpCampaignReport(userId: string, providerCampaignId: string): Promise<MailchimpCampaignReport> {
  const data = await request<Record<string, unknown>>(userId, `/reports/${encodeURIComponent(providerCampaignId)}`, "GET");
  const bounces = objectData(data.bounces);
  return {
    emailsSent: typeof data.emails_sent === "number" ? data.emails_sent : 0,
    opens: typeof data.opens === "number" ? data.opens : 0,
    uniqueOpens: typeof data.unique_opens === "number" ? data.unique_opens : 0,
    clicks: typeof data.clicks === "number" ? data.clicks : 0,
    uniqueClicks: typeof data.unique_clicks === "number" ? data.unique_clicks : 0,
    unsubscribes: typeof data.unsubscribed === "number" ? data.unsubscribed : 0,
    bounces: (typeof bounces.hard_bounces === "number" ? bounces.hard_bounces : 0) +
      (typeof bounces.soft_bounces === "number" ? bounces.soft_bounces : 0),
    openRate: typeof data.open_rate === "number" ? data.open_rate : 0,
    clickRate: typeof data.click_rate === "number" ? data.click_rate : 0,
  };
}

export async function getMailchimpCampaignInfo(userId: string, providerCampaignId: string): Promise<{ status: string; scheduledAt: string | null; title: string | null; audienceId: string | null }> {
  const info = await request<Record<string, unknown>>(userId, `/campaigns/${encodeURIComponent(providerCampaignId)}`, "GET");
  const settings = objectData(info.settings);
  const recipients = objectData(info.recipients);
  return {
    status: typeof info.status === "string" ? info.status : "unknown",
    scheduledAt: typeof info.send_time === "string" ? info.send_time : null,
    title: typeof settings.title === "string" ? settings.title : null,
    audienceId: typeof recipients.list_id === "string" ? recipients.list_id : null,
  };
}

export async function refreshMailchimpCampaignDraft(userId: string, input: {
  providerCampaignId: string; subject: string; body: string; fromName: string; replyTo: string;
}): Promise<void> {
  const id = encodeURIComponent(input.providerCampaignId);
  await request(userId, `/campaigns/${id}`, "PATCH", {
    settings: { subject_line: input.subject, from_name: input.fromName, reply_to: input.replyTo },
  });
  await request(userId, `/campaigns/${id}/content`, "PUT", { html: toHtml(input.body), plain_text: input.body });
}
