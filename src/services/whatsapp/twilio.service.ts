/**
 * WhatsApp via Twilio (Personal Mode). Server-credential based (not per-user OAuth):
 * configured once with a Twilio account + a WhatsApp-enabled sender. Send-focused —
 * there is no personal-WhatsApp inbox API. See doc/twilio-whatsapp-setup.md.
 */

import { BadRequestError } from "../../utils/errors";

function accountSid(): string {
  const v = process.env.TWILIO_ACCOUNT_SID;
  if (!v) throw new BadRequestError("WhatsApp isn't configured on the server (TWILIO_ACCOUNT_SID missing).");
  return v;
}
function authToken(): string {
  const v = process.env.TWILIO_AUTH_TOKEN;
  if (!v) throw new BadRequestError("WhatsApp isn't configured on the server (TWILIO_AUTH_TOKEN missing).");
  return v;
}
function fromNumber(): string {
  const v = process.env.TWILIO_WHATSAPP_FROM;
  if (!v) throw new BadRequestError("WhatsApp isn't configured on the server (TWILIO_WHATSAPP_FROM missing).");
  // Accept either "+123…" or "whatsapp:+123…".
  return v.startsWith("whatsapp:") ? v : `whatsapp:${v}`;
}

/** True when the server has Twilio WhatsApp credentials set. */
export function isWhatsAppConfigured(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);
}

function toWhatsApp(number: string): string {
  const trimmed = number.trim();
  return trimmed.startsWith("whatsapp:") ? trimmed : `whatsapp:${trimmed}`;
}

/** Send a WhatsApp message to a phone number (E.164, e.g. +8801…). */
export async function sendWhatsAppMessage(to: string, body: string): Promise<{ sid: string }> {
  const sid = accountSid();
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${authToken()}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: fromNumber(), To: toWhatsApp(to), Body: body }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    let detail = t.slice(0, 200);
    try {
      detail = (JSON.parse(t) as { message?: string }).message ?? detail;
    } catch {
      /* keep raw */
    }
    throw new BadRequestError(`WhatsApp send failed: ${detail}`);
  }

  const data = (await res.json()) as { sid?: string };
  return { sid: data.sid ?? "" };
}
