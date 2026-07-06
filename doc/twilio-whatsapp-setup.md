# WhatsApp via Twilio — setup

WhatsApp has **no API for personal accounts**. Interlink sends WhatsApp messages through **Twilio's**
WhatsApp API — it is **send-focused** (outbound notifications/messages from workflows), not a personal
inbox. The backend code (`src/services/whatsapp/twilio.service.ts`, tool `send_whatsapp_message`) only
needs the credentials below.

## 1. Twilio account + WhatsApp sender

1. Create a Twilio account at <https://www.twilio.com>.
2. For testing, use the **WhatsApp Sandbox** (Messaging → Try it out → Send a WhatsApp message): Twilio
   gives you a sandbox sender like `+1 415 523 8886` and a join code recipients must send once to opt in.
3. For production, register a WhatsApp Business sender (requires Meta business verification through Twilio).

## 2. Environment variables

```
TWILIO_ACCOUNT_SID=<from Twilio console>
TWILIO_AUTH_TOKEN=<from Twilio console>
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886   # your Twilio WhatsApp sender, E.164 with the whatsapp: prefix
```

## 3. Usage

From the assistant: *"Send a WhatsApp to +8801XXXXXXXXX saying I'm running 10 minutes late."* The
assistant proposes a `send_whatsapp_message` action; on confirm it sends via Twilio.

**Limits:** recipients must have opted in (sandbox join code, or a Meta-approved template/session for
production). Delivery outside a 24-hour session window requires pre-approved message templates.
